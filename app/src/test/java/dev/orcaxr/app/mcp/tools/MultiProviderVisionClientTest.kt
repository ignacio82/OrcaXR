package dev.orcaxr.app.mcp.tools

import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MultiProviderVisionClientTest {

    private data class Call(val url: String, val headers: Map<String, String>, val body: String)

    /** Sequential scripted transport that records every call. */
    private class FakeTransport(private val responses: MutableList<HttpTransport.HttpResult>) :
        HttpTransport {
        val calls = mutableListOf<Call>()
        override suspend fun post(
            url: String,
            headers: Map<String, String>,
            jsonBody: String,
        ): HttpTransport.HttpResult {
            calls.add(Call(url, headers, jsonBody))
            return if (responses.isNotEmpty()) responses.removeAt(0)
            else HttpTransport.HttpResult(500, "exhausted")
        }
    }

    private fun anthropicReq(): JSONObject = JSONObject().apply {
        put("model", "claude-haiku-4-5")
        put("max_tokens", 512)
        put("system", "be terse")
        put("messages", JSONArray().apply {
            put(JSONObject().apply {
                put("role", "user")
                put("content", JSONArray().apply {
                    put(JSONObject().apply { put("type", "text"); put("text", "hello") })
                    put(JSONObject().apply {
                        put("type", "image")
                        put("source", JSONObject().apply {
                            put("type", "base64"); put("media_type", "image/png"); put("data", "QUJD")
                        })
                    })
                })
            })
        })
    }

    private fun ok(body: String) = HttpTransport.HttpResult(200, body)

    @Test fun claudePassthroughNormalizesAndPostsAnthropic() = runTest {
        val t = FakeTransport(mutableListOf(
            ok("""{"content":[{"type":"text","text":"hi there"}]}"""),
        ))
        val c = MultiProviderVisionClient(VisionProvider.CLAUDE, t, rateLimit = false)
        val r = c.send("k1", anthropicReq())
        assertTrue(r.isSuccess)
        val text = r.getOrNull()!!.getJSONArray("content").getJSONObject(0).getString("text")
        assertEquals("hi there", text)
        val call = t.calls.single()
        assertTrue(call.url.contains("api.anthropic.com"))
        assertEquals("k1", call.headers["x-api-key"])
        assertTrue(call.body.contains("\"data\":\"QUJD\""))
    }

    @Test fun openAiStyleRequestShapeAndResponseExtraction() = runTest {
        val t = FakeTransport(mutableListOf(
            ok("""{"choices":[{"message":{"content":"answer"}}]}"""),
        ))
        val c = MultiProviderVisionClient(VisionProvider.OPENAI, t, rateLimit = false)
        val r = c.send("sk-test", anthropicReq())
        assertEquals(
            "answer",
            r.getOrNull()!!.getJSONArray("content").getJSONObject(0).getString("text"),
        )
        val call = t.calls.single()
        assertTrue(call.url.contains("api.openai.com"))
        assertEquals("Bearer sk-test", call.headers["Authorization"])
        val body = JSONObject(call.body)
        val msgs = body.getJSONArray("messages")
        assertEquals("system", msgs.getJSONObject(0).getString("role"))
        val userContent = msgs.getJSONObject(1).getJSONArray("content")
        // text part + image_url data URL.
        assertEquals("text", userContent.getJSONObject(0).getString("type"))
        assertEquals("image_url", userContent.getJSONObject(1).getString("type"))
        assertTrue(
            userContent.getJSONObject(1).getJSONObject("image_url").getString("url")
                .startsWith("data:image/png;base64,QUJD"),
        )
    }

    @Test fun geminiWalksModelFallbackChain() = runTest {
        val t = FakeTransport(mutableListOf(
            HttpTransport.HttpResult(500, "quota"),                   // gemini-2.5-pro
            ok("""{"candidates":[{"content":{"parts":[{"text":"G2"}]}}]}"""), // 2.5-flash
        ))
        val c = MultiProviderVisionClient(VisionProvider.GEMINI, t, rateLimit = false)
        val r = c.send("gkey", anthropicReq())
        assertEquals(
            "G2",
            r.getOrNull()!!.getJSONArray("content").getJSONObject(0).getString("text"),
        )
        assertEquals(2, t.calls.size)
        assertTrue(t.calls[0].url.contains("gemini-2.5-pro"))
        assertTrue(t.calls[1].url.contains("gemini-2.5-flash"))
        assertTrue(t.calls[0].url.contains("key=gkey"))
        // Gemini wire format: contents[0].parts[] with inline_data.
        val body = JSONObject(t.calls[0].body)
        val parts = body.getJSONArray("contents").getJSONObject(0).getJSONArray("parts")
        assertTrue((0 until parts.length()).any { parts.getJSONObject(it).has("inline_data") })
    }

    @Test fun allAttemptsFailingYieldsFailure() = runTest {
        val t = FakeTransport(mutableListOf(
            HttpTransport.HttpResult(500, "a"),
            HttpTransport.HttpResult(500, "b"),
            HttpTransport.HttpResult(500, "c"),
        ))
        val c = MultiProviderVisionClient(VisionProvider.GEMINI, t, rateLimit = false)
        val r = c.send("k", anthropicReq())
        assertTrue(r.isFailure)
    }

    @Test fun pollinationsWorksWithoutKey() = runTest {
        val t = FakeTransport(mutableListOf(ok("""{"choices":[{"message":{"content":"free"}}]}""")))
        val c = MultiProviderVisionClient(VisionProvider.POLLINATIONS, t, rateLimit = false)
        val r = c.send("", anthropicReq())
        assertEquals(
            "free",
            r.getOrNull()!!.getJSONArray("content").getJSONObject(0).getString("text"),
        )
        assertFalse(t.calls.single().headers.containsKey("Authorization"))
    }

    @Test fun providerFromIdIsLenient() {
        assertEquals(VisionProvider.GEMINI, VisionProvider.fromId("gemini"))
        assertEquals(VisionProvider.CLAUDE, VisionProvider.fromId("nonsense"))
    }
}
