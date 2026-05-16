package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.mcp.VisionRateLimiter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Borrowed idea #3 from `u1-slicer-for-android`: a multi-provider,
 * free-tier-first vision client with model fallback chains.
 *
 * It implements the existing [VisionApiClient] seam, so any vision tool
 * works with it unchanged: the tool keeps building an **Anthropic-shaped
 * request** ({model, max_tokens, system, messages:[{role:user,
 * content:[text|image]}]}); this client translates that to the selected
 * provider's wire format and **normalizes the reply back** to the
 * Anthropic shape ({content:[{type:text,text:…}]}) the tools parse.
 *
 * Providers (mirrors their AiLabelClient): Claude (pass-through),
 * Gemini (free 1k/day, 3-model fallback chain), OpenAI, OpenRouter,
 * Pollinations (free, key optional). Graceful: returns
 * `Result.failure` so the caller can fall back to the deterministic
 * path (their "AI is decorative" principle).
 *
 * HTTP is injectable ([HttpTransport]) so this is unit-tested without
 * a network. The shared [VisionRateLimiter] gate is honored, matching
 * [OkHttpVisionApiClient].
 */
internal enum class VisionProvider(
    val displayName: String,
    val requiresKey: Boolean,
    val acceptsKey: Boolean = requiresKey,
) {
    CLAUDE("Claude (Anthropic)", true),
    GEMINI("Google Gemini (free 1k/day)", true),
    OPENROUTER("OpenRouter", true),
    OPENAI("OpenAI", true),
    POLLINATIONS("Pollinations.ai (free; key optional)", false, acceptsKey = true);

    companion object {
        val DEFAULT = CLAUDE
        fun fromId(id: String): VisionProvider =
            entries.firstOrNull { it.name.equals(id.trim(), ignoreCase = true) } ?: DEFAULT
    }
}

/** Injectable HTTP seam. [headers] excludes Content-Type (always JSON). */
internal interface HttpTransport {
    suspend fun post(url: String, headers: Map<String, String>, jsonBody: String): HttpResult
    data class HttpResult(val code: Int, val body: String?)
}

internal class OkHttpTransport : HttpTransport {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()
    private val json = "application/json; charset=utf-8".toMediaType()

    override suspend fun post(
        url: String,
        headers: Map<String, String>,
        jsonBody: String,
    ): HttpTransport.HttpResult = withContext(Dispatchers.IO) {
        val b = Request.Builder().url(url).post(jsonBody.toRequestBody(json))
        for ((k, v) in headers) b.header(k, v)
        http.newCall(b.build()).execute().use { r ->
            HttpTransport.HttpResult(r.code, r.body?.string())
        }
    }
}

internal class MultiProviderVisionClient(
    private val provider: VisionProvider,
    private val transport: HttpTransport = OkHttpTransport(),
    /** Gemini free-tier chain — quality-first, quota-tightest first. */
    private val geminiModels: List<String> = listOf(
        "gemini-2.5-pro", "gemini-2.5-flash", "gemini-1.5-flash",
    ),
    private val rateLimit: Boolean = true,
) : VisionApiClient {

    /** One ordered request part extracted from the Anthropic-shaped body. */
    private sealed interface Part {
        data class Text(val text: String) : Part
        data class Image(val mediaType: String, val b64: String) : Part
    }

    override suspend fun send(apiKey: String, requestBody: JSONObject): Result<JSONObject> {
        if (rateLimit) VisionRateLimiter.shared.acquire()
        return runCatching {
            val model = requestBody.optString("model").ifEmpty { defaultModel() }
            val maxTokens = requestBody.optInt("max_tokens", 1024)
            val system = requestBody.optString("system", "")
            val parts = extractParts(requestBody)

            // Provider attempts: Gemini walks its model chain; the rest
            // are a single attempt.
            val attempts: List<Pair<String, () -> Triple<String, Map<String, String>, String>>> =
                if (provider == VisionProvider.GEMINI) {
                    geminiModels.map { m -> m to { geminiRequest(apiKey, m, system, parts) } }
                } else {
                    listOf(model to { providerRequest(apiKey, model, maxTokens, system, parts) })
                }

            var lastErr = "no attempt made"
            for ((label, build) in attempts) {
                val (url, headers, body) = build()
                val res = transport.post(url, headers, body)
                val rb = res.body
                if (res.code !in 200..299 || rb == null) {
                    lastErr = "$label: HTTP ${res.code} ${rb?.take(300) ?: ""}"
                    continue
                }
                val text = extractText(rb)
                if (text != null) {
                    return@runCatching JSONObject().apply {
                        put("content", JSONArray().apply {
                            put(JSONObject().apply { put("type", "text"); put("text", text) })
                        })
                    }
                }
                lastErr = "$label: unparseable body ${rb.take(300)}"
            }
            throw IllegalStateException("All ${provider.name} attempts failed: $lastErr")
        }
    }

    private fun defaultModel(): String = when (provider) {
        VisionProvider.CLAUDE -> "claude-haiku-4-5"
        VisionProvider.GEMINI -> geminiModels.first()
        VisionProvider.OPENAI -> "gpt-4o-mini"
        VisionProvider.OPENROUTER -> "qwen/qwen-2.5-vl-72b-instruct:free"
        VisionProvider.POLLINATIONS -> "openai"
    }

    private fun extractParts(body: JSONObject): List<Part> {
        val out = ArrayList<Part>()
        val messages = body.optJSONArray("messages") ?: return out
        for (mi in 0 until messages.length()) {
            val content = messages.optJSONObject(mi)?.optJSONArray("content") ?: continue
            for (ci in 0 until content.length()) {
                val p = content.optJSONObject(ci) ?: continue
                when (p.optString("type")) {
                    "text" -> out.add(Part.Text(p.optString("text")))
                    "image" -> {
                        val src = p.optJSONObject("source") ?: continue
                        out.add(Part.Image(src.optString("media_type", "image/png"), src.optString("data")))
                    }
                }
            }
        }
        return out
    }

    private fun providerRequest(
        apiKey: String,
        model: String,
        maxTokens: Int,
        system: String,
        parts: List<Part>,
    ): Triple<String, Map<String, String>, String> = when (provider) {
        VisionProvider.CLAUDE -> {
            val content = JSONArray()
            for (p in parts) when (p) {
                is Part.Text -> content.put(JSONObject().put("type", "text").put("text", p.text))
                is Part.Image -> content.put(
                    JSONObject().put("type", "image").put(
                        "source",
                        JSONObject().put("type", "base64")
                            .put("media_type", p.mediaType).put("data", p.b64),
                    ),
                )
            }
            val body = JSONObject()
                .put("model", model).put("max_tokens", maxTokens)
                .apply { if (system.isNotEmpty()) put("system", system) }
                .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", content)))
            Triple(
                "https://api.anthropic.com/v1/messages",
                mapOf("x-api-key" to apiKey, "anthropic-version" to "2023-06-01"),
                body.toString(),
            )
        }
        VisionProvider.GEMINI -> geminiRequest(apiKey, model, system, parts)
        VisionProvider.OPENAI -> openAiStyle(
            "https://api.openai.com/v1/chat/completions", apiKey, model, maxTokens, system, parts,
        )
        VisionProvider.OPENROUTER -> openAiStyle(
            "https://openrouter.ai/api/v1/chat/completions", apiKey, model, maxTokens, system, parts,
        )
        VisionProvider.POLLINATIONS -> openAiStyle(
            "https://text.pollinations.ai/openai/chat/completions",
            apiKey.ifBlank { null }, model, maxTokens, system, parts,
        )
    }

    private fun openAiStyle(
        url: String,
        apiKey: String?,
        model: String,
        maxTokens: Int,
        system: String,
        parts: List<Part>,
    ): Triple<String, Map<String, String>, String> {
        val userContent = JSONArray()
        for (p in parts) when (p) {
            is Part.Text -> userContent.put(JSONObject().put("type", "text").put("text", p.text))
            is Part.Image -> userContent.put(
                JSONObject().put("type", "image_url").put(
                    "image_url",
                    JSONObject().put("url", "data:${p.mediaType};base64,${p.b64}"),
                ),
            )
        }
        val messages = JSONArray()
        if (system.isNotEmpty()) {
            messages.put(JSONObject().put("role", "system").put("content", system))
        }
        messages.put(JSONObject().put("role", "user").put("content", userContent))
        val body = JSONObject().put("model", model).put("max_tokens", maxTokens)
            .put("messages", messages)
        val headers = if (apiKey != null) mapOf("Authorization" to "Bearer $apiKey") else emptyMap()
        return Triple(url, headers, body.toString())
    }

    private fun geminiRequest(
        apiKey: String,
        model: String,
        system: String,
        parts: List<Part>,
    ): Triple<String, Map<String, String>, String> {
        val partsArr = JSONArray()
        if (system.isNotEmpty()) partsArr.put(JSONObject().put("text", system))
        for (p in parts) when (p) {
            is Part.Text -> partsArr.put(JSONObject().put("text", p.text))
            is Part.Image -> partsArr.put(
                JSONObject().put(
                    "inline_data",
                    JSONObject().put("mime_type", p.mediaType).put("data", p.b64),
                ),
            )
        }
        val body = JSONObject().put(
            "contents", JSONArray().put(JSONObject().put("parts", partsArr)),
        )
        return Triple(
            "https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent?key=$apiKey",
            emptyMap(),
            body.toString(),
        )
    }

    /** Normalize any provider's reply to the assistant's text, or null
     *  if the body doesn't carry one. */
    private fun extractText(body: String): String? = runCatching {
        val json = JSONObject(body)
        when (provider) {
            VisionProvider.GEMINI -> json.getJSONArray("candidates")
                .getJSONObject(0).getJSONObject("content")
                .getJSONArray("parts").getJSONObject(0).getString("text")
            VisionProvider.CLAUDE -> json.getJSONArray("content")
                .getJSONObject(0).getString("text")
            else -> json.getJSONArray("choices")
                .getJSONObject(0).getJSONObject("message").getString("content")
        }
    }.getOrNull()?.takeIf { it.isNotBlank() }
}
