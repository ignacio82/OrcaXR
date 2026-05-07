package dev.orcaxr.app.llm

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Provider-agnostic in-app LLM client. Three implementations
 * ([ClaudeLlmClient], [GeminiLlmClient], [OpenAiLlmClient]) all
 * translate this same contract into their respective wire formats.
 *
 * Why hand-rolled instead of pulling in the official SDKs:
 * - Each provider's SDK adds 1–3 MB of method count to the APK.
 * - We only need chat + tool use; that's ~150 lines per provider.
 * - The OrcaXR build already speaks OkHttp + org.json end-to-end.
 *
 * Tool use is first-class. When the model issues tool calls, the
 * client returns them in [LlmResponse.toolCalls]; the chat panel
 * runs each tool through OrcaXR's own [dev.orcaxr.app.mcp.Tool]
 * registry, appends the results to history as [LlmTurn.ToolResult]
 * entries, and re-invokes [LlmClient.respond]. The loop ends when
 * the model returns a final text turn with no tool calls.
 */
interface LlmClient {
    val provider: LlmProvider

    suspend fun respond(
        history: List<LlmTurn>,
        tools: List<LlmToolDef>,
        systemPrompt: String,
    ): Result<LlmResponse>

    companion object {
        /** Build a client for [p]. When [model] is non-blank it
         *  overrides the per-provider DEFAULT_MODEL constant. The
         *  user-facing model field in LlmAssistantCard threads the
         *  override here so the user can paste in a model id their
         *  key has access to without a code change. */
        fun forProvider(p: LlmProvider, apiKey: String, model: String? = null): LlmClient {
            val resolved = model?.takeIf { it.isNotBlank() }
            return when (p) {
                LlmProvider.Claude -> ClaudeLlmClient(apiKey, resolved ?: ClaudeLlmClient.DEFAULT_MODEL)
                LlmProvider.Gemini -> GeminiLlmClient(apiKey, resolved ?: GeminiLlmClient.DEFAULT_MODEL)
                LlmProvider.OpenAI -> OpenAiLlmClient(apiKey, resolved ?: OpenAiLlmClient.DEFAULT_MODEL)
            }
        }
    }
}

/** One conversation turn. The history grows by appending these. */
sealed interface LlmTurn {
    data class User(val text: String) : LlmTurn
    /** Assistant produced free text (may co-exist with tool calls). */
    data class Assistant(val text: String?, val toolCalls: List<ToolCall>) : LlmTurn
    /** Result of running one tool call requested by the assistant. */
    data class ToolResult(
        val callId: String,
        val name: String,
        val content: String,
        val isError: Boolean,
    ) : LlmTurn
}

data class ToolCall(val id: String, val name: String, val args: JSONObject)

/**
 * Tool description handed to the model. Lifted directly from
 * [dev.orcaxr.app.mcp.Tool] — name + description + JSON-schema args.
 */
data class LlmToolDef(val name: String, val description: String, val inputSchema: JSONObject)

data class LlmResponse(
    /** Assistant's free-text content, if any. May be null when the
     *  model only issued tool calls. */
    val text: String?,
    /** Tool calls the model wants the caller to execute. */
    val toolCalls: List<ToolCall>,
    /** Provider-specific stop reason ("end_turn", "tool_use", …) for
     *  diagnostics. Not load-bearing. */
    val stopReason: String?,
)

private val httpClient: OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(120, TimeUnit.SECONDS)
    .build()

private const val JSON_MIME = "application/json"

private fun postJson(
    url: String,
    headers: Map<String, String>,
    body: JSONObject,
): Result<JSONObject> = runCatching {
    val req = Request.Builder()
        .url(url)
        .post(body.toString().toRequestBody(JSON_MIME.toMediaType()))
        .apply { for ((k, v) in headers) addHeader(k, v) }
        .build()
    httpClient.newCall(req).execute().use { resp ->
        val text = resp.body?.string() ?: throw IllegalStateException("empty body")
        if (!resp.isSuccessful) {
            throw IllegalStateException("HTTP ${resp.code}: ${text.take(800)}")
        }
        JSONObject(text)
    }
}

/* -------------------------------------------------------------------- */
/*  Claude (Anthropic Messages API)                                     */
/* -------------------------------------------------------------------- */

internal class ClaudeLlmClient(
    private val apiKey: String,
    private val model: String = DEFAULT_MODEL,
) : LlmClient {
    override val provider = LlmProvider.Claude

    override suspend fun respond(
        history: List<LlmTurn>,
        tools: List<LlmToolDef>,
        systemPrompt: String,
    ): Result<LlmResponse> {
        val body = JSONObject().apply {
            put("model", model)
            put("max_tokens", 4096)
            if (systemPrompt.isNotBlank()) put("system", systemPrompt)
            put("messages", JSONArray().also { arr ->
                for (m in toClaudeMessages(history)) arr.put(m)
            })
            if (tools.isNotEmpty()) {
                put("tools", JSONArray().also { arr ->
                    for (t in tools) arr.put(JSONObject().apply {
                        put("name", t.name)
                        put("description", t.description)
                        put("input_schema", t.inputSchema)
                    })
                })
            }
        }
        val resp = postJson(
            "https://api.anthropic.com/v1/messages",
            mapOf(
                "x-api-key" to apiKey,
                "anthropic-version" to "2023-06-01",
            ),
            body,
        )
        return resp.mapCatching { json ->
            val content = json.optJSONArray("content") ?: JSONArray()
            val text = StringBuilder()
            val calls = mutableListOf<ToolCall>()
            for (i in 0 until content.length()) {
                val part = content.optJSONObject(i) ?: continue
                when (part.optString("type")) {
                    "text" -> text.append(part.optString("text"))
                    "tool_use" -> calls.add(
                        ToolCall(
                            id = part.optString("id"),
                            name = part.optString("name"),
                            args = part.optJSONObject("input") ?: JSONObject(),
                        ),
                    )
                }
            }
            LlmResponse(
                text = text.toString().ifBlank { null },
                toolCalls = calls,
                stopReason = json.optString("stop_reason").ifBlank { null },
            )
        }
    }

    private fun toClaudeMessages(history: List<LlmTurn>): List<JSONObject> {
        // Claude wants tool_result blocks attached to a USER message
        // immediately following the assistant's tool_use turn.
        val out = mutableListOf<JSONObject>()
        var i = 0
        while (i < history.size) {
            val turn = history[i]
            when (turn) {
                is LlmTurn.User -> out.add(userTextMessage(turn.text))
                is LlmTurn.Assistant -> {
                    val parts = JSONArray()
                    if (!turn.text.isNullOrBlank()) parts.put(JSONObject().apply {
                        put("type", "text"); put("text", turn.text)
                    })
                    for (c in turn.toolCalls) parts.put(JSONObject().apply {
                        put("type", "tool_use"); put("id", c.id)
                        put("name", c.name); put("input", c.args)
                    })
                    out.add(JSONObject().apply { put("role", "assistant"); put("content", parts) })
                }
                is LlmTurn.ToolResult -> {
                    // Coalesce consecutive tool results into one user turn.
                    val parts = JSONArray()
                    var j = i
                    while (j < history.size && history[j] is LlmTurn.ToolResult) {
                        val t = history[j] as LlmTurn.ToolResult
                        parts.put(JSONObject().apply {
                            put("type", "tool_result")
                            put("tool_use_id", t.callId)
                            put("content", t.content)
                            if (t.isError) put("is_error", true)
                        })
                        j++
                    }
                    out.add(JSONObject().apply { put("role", "user"); put("content", parts) })
                    i = j
                    continue
                }
            }
            i++
        }
        return out
    }

    private fun userTextMessage(text: String): JSONObject = JSONObject().apply {
        put("role", "user")
        put("content", JSONArray().put(JSONObject().apply {
            put("type", "text"); put("text", text)
        }))
    }

    companion object {
        const val DEFAULT_MODEL = "claude-haiku-4-5"
    }
}

/* -------------------------------------------------------------------- */
/*  Gemini (Google AI Studio generativelanguage.googleapis.com)         */
/* -------------------------------------------------------------------- */

internal class GeminiLlmClient(
    private val apiKey: String,
    private val model: String = DEFAULT_MODEL,
) : LlmClient {
    override val provider = LlmProvider.Gemini

    override suspend fun respond(
        history: List<LlmTurn>,
        tools: List<LlmToolDef>,
        systemPrompt: String,
    ): Result<LlmResponse> {
        val body = JSONObject().apply {
            if (systemPrompt.isNotBlank()) {
                put("systemInstruction", JSONObject().apply {
                    put("parts", JSONArray().put(JSONObject().put("text", systemPrompt)))
                })
            }
            put("contents", JSONArray().also { arr ->
                for (c in toGeminiContents(history)) arr.put(c)
            })
            if (tools.isNotEmpty()) {
                val decls = JSONArray()
                for (t in tools) decls.put(JSONObject().apply {
                    put("name", t.name)
                    put("description", t.description)
                    put("parameters", sanitizeSchemaForGemini(t.inputSchema))
                })
                put("tools", JSONArray().put(JSONObject().put("functionDeclarations", decls)))
            }
        }
        val url = "https://generativelanguage.googleapis.com/v1beta/models/$model:generateContent?key=$apiKey"
        val resp = postJson(url, emptyMap(), body)
        return resp.mapCatching { json ->
            val candidates = json.optJSONArray("candidates")
                ?: throw IllegalStateException("no candidates: ${json.toString().take(400)}")
            val first = candidates.optJSONObject(0)
                ?: throw IllegalStateException("empty candidates")
            val content = first.optJSONObject("content")
            val parts = content?.optJSONArray("parts") ?: JSONArray()
            val text = StringBuilder()
            val calls = mutableListOf<ToolCall>()
            for (i in 0 until parts.length()) {
                val p = parts.optJSONObject(i) ?: continue
                when {
                    p.has("text") -> text.append(p.optString("text"))
                    p.has("functionCall") -> {
                        val fc = p.getJSONObject("functionCall")
                        calls.add(
                            ToolCall(
                                // Gemini doesn't return an id; synthesize one
                                // so the chat panel can correlate. Stable
                                // within a single turn — that's all we need.
                                id = "gemini_${UUID.randomUUID().toString().take(8)}",
                                name = fc.optString("name"),
                                args = fc.optJSONObject("args") ?: JSONObject(),
                            ),
                        )
                    }
                }
            }
            LlmResponse(
                text = text.toString().ifBlank { null },
                toolCalls = calls,
                stopReason = first.optString("finishReason").ifBlank { null },
            )
        }
    }

    private fun toGeminiContents(history: List<LlmTurn>): List<JSONObject> {
        val out = mutableListOf<JSONObject>()
        for (turn in history) {
            when (turn) {
                is LlmTurn.User -> out.add(JSONObject().apply {
                    put("role", "user")
                    put("parts", JSONArray().put(JSONObject().put("text", turn.text)))
                })
                is LlmTurn.Assistant -> {
                    val parts = JSONArray()
                    if (!turn.text.isNullOrBlank()) parts.put(JSONObject().put("text", turn.text))
                    for (c in turn.toolCalls) parts.put(JSONObject().apply {
                        put("functionCall", JSONObject().apply {
                            put("name", c.name); put("args", c.args)
                        })
                    })
                    out.add(JSONObject().apply { put("role", "model"); put("parts", parts) })
                }
                is LlmTurn.ToolResult -> out.add(JSONObject().apply {
                    put("role", "user")
                    val response = JSONObject().apply {
                        if (turn.isError) put("error", turn.content) else put("result", turn.content)
                    }
                    put("parts", JSONArray().put(JSONObject().apply {
                        put("functionResponse", JSONObject().apply {
                            put("name", turn.name); put("response", response)
                        })
                    }))
                })
            }
        }
        return out
    }

    /**
     * Gemini's function-declaration parser is stricter than Anthropic's
     * — it rejects `additionalProperties` AND a handful of JSON Schema
     * draft-2020 keys it doesn't understand (`$schema`, `$id`, `$ref`,
     * `definitions`, `examples`). It also gets confused by empty
     * `properties` blocks on `type: object`.
     *
     * The MCP tool catalog has 100+ tools and many use deeply-nested
     * schemas (object → properties → object → properties → object,
     * 4+ levels). The original sanitizer only walked the top-level +
     * immediate children, which is why this 400'd in production:
     *
     *     "Unknown name \"additionalProperties\" at
     *      'tools[0].function_declarations[94].parameters
     *       .properties[2].value.properties[1].value'"
     *
     * Fix: recursive walk. For every nested schema node we (a) remove
     * the offending keys, (b) recurse into `properties[*]`, `items`,
     * and `oneOf` / `anyOf` / `allOf` arrays so no descendant escapes
     * the strip. Then patch the empty-properties case at the top
     * level only — Gemini wants a placeholder property when type is
     * object, but inner empty objects (legitimate dictionaries) are
     * left alone.
     *
     * We deep-copy the input via `JSONObject(toString())` so the
     * caller's MCP tool schema is never mutated — the same registry
     * feeds Claude / OpenAI clients which DO accept these keys.
     */
    internal fun sanitizeSchemaForGemini(schema: JSONObject): JSONObject {
        val cleaned = JSONObject(schema.toString())
        scrubGeminiUnsupportedRecursively(cleaned)
        if (cleaned.optString("type") == "object") {
            val props = cleaned.optJSONObject("properties")
            if (props == null || props.length() == 0) {
                cleaned.put(
                    "properties",
                    JSONObject().put(
                        "_unused",
                        JSONObject().apply {
                            put("type", "string")
                            put("description", "ignored")
                        },
                    ),
                )
            }
        }
        return cleaned
    }

    /**
     * Walk a schema node and remove any keys Gemini's
     * function-declaration parser refuses. Recurses into every
     * structural position (`properties[*]`, `items`, `oneOf` /
     * `anyOf` / `allOf` arrays, and `not`).
     */
    private fun scrubGeminiUnsupportedRecursively(node: JSONObject) {
        // Strip every Gemini-incompatible key at this level. The list
        // is conservative; if a future Gemini release adds support for
        // any of these, the worst case is "we sent slightly less
        // metadata," not "we crash." Better than the alternative
        // (HTTP 400 surfacing as a confusing error in the chat panel).
        for (key in GEMINI_UNSUPPORTED_KEYS) node.remove(key)

        // Recurse into every structural position. JSONObject.keys()
        // returns a snapshot iterator on Android's org.json so we can
        // iterate while the underlying map is mutated by recursive
        // scrubs deeper in the tree.
        node.optJSONObject("properties")?.let { props ->
            for (k in props.keys()) {
                props.optJSONObject(k)?.let { scrubGeminiUnsupportedRecursively(it) }
            }
        }
        node.optJSONObject("items")?.let { scrubGeminiUnsupportedRecursively(it) }
        // `items` may also be an array of schemas in tuple form.
        node.optJSONArray("items")?.let { arr ->
            for (i in 0 until arr.length()) {
                arr.optJSONObject(i)?.let { scrubGeminiUnsupportedRecursively(it) }
            }
        }
        for (variant in listOf("oneOf", "anyOf", "allOf")) {
            node.optJSONArray(variant)?.let { arr ->
                for (i in 0 until arr.length()) {
                    arr.optJSONObject(i)?.let { scrubGeminiUnsupportedRecursively(it) }
                }
            }
        }
        node.optJSONObject("not")?.let { scrubGeminiUnsupportedRecursively(it) }
        // `additionalProperties` may itself BE a schema object on some
        // tools (rare but legal). The top-level remove above kills it
        // outright; nothing left to recurse into.
        // `patternProperties` follows the same shape as `properties`.
        node.optJSONObject("patternProperties")?.let { props ->
            for (k in props.keys()) {
                props.optJSONObject(k)?.let { scrubGeminiUnsupportedRecursively(it) }
            }
        }
    }

    companion object {
        const val DEFAULT_MODEL = "gemini-3-flash-preview"

        // Keys Gemini's function-declaration parser does NOT accept.
        // Sourced from the actual 400 the field reported plus the
        // documented intersection of Gemini's "OpenAPI 3.0 subset"
        // schema support vs full JSON Schema draft-2020.
        internal val GEMINI_UNSUPPORTED_KEYS =
            listOf(
                "additionalProperties",
                "\$schema",
                "\$id",
                "\$ref",
                "\$defs",
                "definitions",
                "examples",
                "patternProperties",
                "unevaluatedProperties",
                "if",
                "then",
                "else",
                "const",
                "contentEncoding",
                "contentMediaType",
                "exclusiveMinimum",
                "exclusiveMaximum",
            )
    }
}

/* -------------------------------------------------------------------- */
/*  OpenAI (Chat Completions API)                                       */
/* -------------------------------------------------------------------- */

internal class OpenAiLlmClient(
    private val apiKey: String,
    private val model: String = DEFAULT_MODEL,
) : LlmClient {
    override val provider = LlmProvider.OpenAI

    override suspend fun respond(
        history: List<LlmTurn>,
        tools: List<LlmToolDef>,
        systemPrompt: String,
    ): Result<LlmResponse> {
        val body = JSONObject().apply {
            put("model", model)
            put("messages", JSONArray().also { arr ->
                if (systemPrompt.isNotBlank()) {
                    arr.put(JSONObject().apply {
                        put("role", "system"); put("content", systemPrompt)
                    })
                }
                for (m in toOpenAiMessages(history)) arr.put(m)
            })
            if (tools.isNotEmpty()) {
                put("tools", JSONArray().also { arr ->
                    for (t in tools) arr.put(JSONObject().apply {
                        put("type", "function")
                        put("function", JSONObject().apply {
                            put("name", t.name)
                            put("description", t.description)
                            put("parameters", t.inputSchema)
                        })
                    })
                })
            }
        }
        val resp = postJson(
            "https://api.openai.com/v1/chat/completions",
            mapOf("Authorization" to "Bearer $apiKey"),
            body,
        )
        return resp.mapCatching { json ->
            val choice = json.optJSONArray("choices")?.optJSONObject(0)
                ?: throw IllegalStateException("no choices: ${json.toString().take(400)}")
            val msg = choice.optJSONObject("message")
                ?: throw IllegalStateException("no message")
            val text = msg.optString("content").takeIf { it.isNotBlank() }
            val callsArr = msg.optJSONArray("tool_calls")
            val calls = mutableListOf<ToolCall>()
            if (callsArr != null) {
                for (i in 0 until callsArr.length()) {
                    val tc = callsArr.optJSONObject(i) ?: continue
                    val fn = tc.optJSONObject("function") ?: continue
                    val argsRaw = fn.optString("arguments", "{}")
                    val args = runCatching { JSONObject(argsRaw) }.getOrDefault(JSONObject())
                    calls.add(
                        ToolCall(
                            id = tc.optString("id"),
                            name = fn.optString("name"),
                            args = args,
                        ),
                    )
                }
            }
            LlmResponse(
                text = text,
                toolCalls = calls,
                stopReason = choice.optString("finish_reason").ifBlank { null },
            )
        }
    }

    private fun toOpenAiMessages(history: List<LlmTurn>): List<JSONObject> {
        val out = mutableListOf<JSONObject>()
        for (turn in history) {
            when (turn) {
                is LlmTurn.User -> out.add(JSONObject().apply {
                    put("role", "user"); put("content", turn.text)
                })
                is LlmTurn.Assistant -> {
                    val o = JSONObject().apply {
                        put("role", "assistant")
                        put("content", turn.text ?: JSONObject.NULL)
                    }
                    if (turn.toolCalls.isNotEmpty()) {
                        o.put("tool_calls", JSONArray().also { arr ->
                            for (c in turn.toolCalls) arr.put(JSONObject().apply {
                                put("id", c.id)
                                put("type", "function")
                                put("function", JSONObject().apply {
                                    put("name", c.name)
                                    put("arguments", c.args.toString())
                                })
                            })
                        })
                    }
                    out.add(o)
                }
                is LlmTurn.ToolResult -> out.add(JSONObject().apply {
                    put("role", "tool")
                    put("tool_call_id", turn.callId)
                    put("content", turn.content)
                })
            }
        }
        return out
    }

    companion object {
        const val DEFAULT_MODEL = "gpt-4o-mini"
    }
}
