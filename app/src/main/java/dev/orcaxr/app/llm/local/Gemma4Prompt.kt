package dev.orcaxr.app.llm.local

import dev.orcaxr.app.llm.LlmResponse
import dev.orcaxr.app.llm.LlmToolDef
import dev.orcaxr.app.llm.LlmTurn
import dev.orcaxr.app.llm.ToolCall
import java.util.UUID
import org.json.JSONObject

/*
 * Pure helpers split out from [LocalLlmClient] so the prompt
 * construction and JSON envelope parsing can be unit-tested in the
 * JVM harness — `LocalLlmClient` itself takes a `Context` and pulls
 * in `com.google.ai.edge.litertlm.Engine` types whose static
 * initializers fail outside an Android runtime. The methods here are
 * deliberately stateless functions on top-level so any test can call
 * them without constructing the client.
 */

/** Caps to keep the small-model context tight. The 4k tool-result
 *  cap matches OrcaAI's AgentLoop.MAX_TOOL_RESULT_CHARS — a verbose
 *  list_placed_models with 50 models would otherwise dominate the
 *  context window. */
internal const val MAX_USER_TURN_CHARS = 4_000
internal const val MAX_TOOL_RESULT_CHARS = 4_000
internal const val MAX_FINAL_FALLBACK_CHARS = 2_000

private const val THINK_OPEN = "<|think|>"
private const val THINK_CLOSE = "<|/think|>"

/**
 * Build the single text prompt fed to Gemma 4 for one turn.
 * Layout:
 *
 *   <system prompt>
 *
 *   You have access to these tools. To call one, respond with EXACTLY
 *   one JSON object on a single line and nothing else:
 *     {"tool":"<name>","arguments":{...}}
 *   When the task is complete, respond with:
 *     {"final":"<your message>"}
 *
 *   Available tools:
 *     - <name>(REQUIRED: a, b; OPTIONAL: c): description-160-chars
 *     ...
 *
 *   Conversation so far:
 *   User: <text>
 *   Assistant: {"tool":"X","arguments":{...}}
 *   Tool result for X: <stringified content>
 *   Assistant:
 */
internal fun buildGemma4Prompt(
    history: List<LlmTurn>,
    tools: List<LlmToolDef>,
    systemPrompt: String,
): String = buildString {
    if (systemPrompt.isNotBlank()) {
        appendLine(systemPrompt.trim())
        appendLine()
    }
    appendLine(
        "You have access to these tools. To call one, respond with EXACTLY one " +
            "JSON object on a single line and nothing else:",
    )
    appendLine("  {\"tool\":\"<name>\",\"arguments\":{...}}")
    appendLine(
        "When the task is complete, or you need to ask the user a question, respond with:",
    )
    appendLine("  {\"final\":\"<your message to the user>\"}")
    appendLine(
        "Do NOT include any text outside the JSON. Do NOT wrap it in code fences. " +
            "One envelope per turn.",
    )
    appendLine()
    appendLine("Available tools:")
    for (t in tools) {
        append("  - ").append(t.name).append('(')
            .append(formatToolParamHint(t.inputSchema))
            .append("): ")
            .appendLine(t.description.take(160))
    }
    appendLine()
    appendLine("Conversation so far:")
    for (turn in history) when (turn) {
        is LlmTurn.User -> {
            append("User: ").appendLine(turn.text.take(MAX_USER_TURN_CHARS))
        }
        is LlmTurn.Assistant -> {
            append("Assistant: ")
            if (turn.toolCalls.isNotEmpty()) {
                val call = turn.toolCalls.first()
                val envelope = JSONObject()
                    .put("tool", call.name)
                    .put("arguments", call.args)
                appendLine(envelope.toString())
            } else {
                val text = turn.text?.takeIf { it.isNotBlank() }
                if (text != null) {
                    appendLine(JSONObject().put("final", text).toString())
                } else {
                    appendLine("{\"final\":\"\"}")
                }
            }
        }
        is LlmTurn.ToolResult -> {
            append("Tool result for ").append(turn.name).append(": ")
            appendLine(
                turn.content.take(MAX_TOOL_RESULT_CHARS).replace('\n', ' '),
            )
        }
    }
    append("Assistant: ")
}

/** Compact "REQUIRED: a, b; OPTIONAL: c" form of an inputSchema.
 *  Mirrors OrcaAI's AgentLoop.formatParamHint. Keeps the catalogue
 *  dense enough that 100+ tools don't blow the small-model context. */
internal fun formatToolParamHint(schema: JSONObject?): String {
    if (schema == null) return "no args"
    val properties = schema.optJSONObject("properties")
    val requiredArr = schema.optJSONArray("required")
    val required = mutableSetOf<String>()
    if (requiredArr != null) {
        for (i in 0 until requiredArr.length()) {
            requiredArr.optString(i).takeIf { it.isNotBlank() }?.let(required::add)
        }
    }
    if (properties == null || properties.length() == 0) return "no args"
    val all = properties.keys().asSequence().toList()
    val req = all.filter { it in required }
    val opt = all.filter { it !in required }
    val parts = buildList {
        if (req.isNotEmpty()) add("REQUIRED: " + req.joinToString(", "))
        if (opt.isNotEmpty()) add("OPTIONAL: " + opt.joinToString(", "))
    }
    return if (parts.isEmpty()) "no args" else parts.joinToString("; ")
}

/**
 * Outcome of parsing the small-model output. The runner / client
 * uses this to decide whether to auto-continue on a truncated turn
 * — [Fallback] means we couldn't find a clean envelope, which is
 * usually because the model ran out of tokens mid-reply.
 */
internal sealed interface ParsedEnvelope {
    data class Tool(val toolName: String, val args: JSONObject, val thought: String?) : ParsedEnvelope
    data class Final(val text: String) : ParsedEnvelope
    /** No envelope detected. Carries the trimmed raw text so the
     *  caller can either return it as a fallback final reply or
     *  feed it into a continuation prompt. */
    data class Fallback(val rawText: String) : ParsedEnvelope
}

/**
 * Parse the model's response into [ParsedEnvelope]. Tries the JSON
 * envelope shapes first (`{"tool":...}` or `{"final":...}`); on
 * failure returns [ParsedEnvelope.Fallback] so the caller can
 * decide whether to retry with a continuation prompt or surface
 * the raw text as final.
 *
 * Mirrors OrcaAI's AgentJson.parse + sanitizeSmallModelJson — the
 * small-model JSON-output failure modes are identical here.
 */
internal fun parseGemma4Envelope(raw: String): ParsedEnvelope {
    val cleaned = stripThinkingBlock(raw).trim()
    val candidate = sanitizeSmallModelJson(cleaned)
    if (candidate.isBlank()) return ParsedEnvelope.Fallback(rawText = cleaned)
    val brace = extractFirstBalancedObject(candidate)
        ?: return ParsedEnvelope.Fallback(rawText = cleaned)
    val obj = runCatching { JSONObject(brace) }.getOrNull()
        ?: return ParsedEnvelope.Fallback(rawText = cleaned)

    val toolName = obj.optString("tool").takeIf { it.isNotBlank() }
    if (toolName != null) {
        val args = obj.optJSONObject("arguments") ?: JSONObject()
        return ParsedEnvelope.Tool(
            toolName = toolName,
            args = args,
            thought = obj.optString("thought").ifBlank { null },
        )
    }
    val finalMsg = obj.optString("final").takeIf { it.isNotBlank() }
    if (finalMsg != null) return ParsedEnvelope.Final(text = finalMsg)

    // Recognized object shape but neither tool nor final — treat
    // as an unparseable response so the caller can retry-or-give-up.
    return ParsedEnvelope.Fallback(rawText = cleaned)
}

/** Adapt a [ParsedEnvelope] into the [LlmResponse] shape the chat
 *  panel expects. Lives here (rather than at the call site) so the
 *  cap on fallback message length stays consistent. */
internal fun envelopeToLlmResponse(parsed: ParsedEnvelope): LlmResponse = when (parsed) {
    is ParsedEnvelope.Tool -> LlmResponse(
        text = parsed.thought,
        toolCalls = listOf(
            ToolCall(
                id = "local_${UUID.randomUUID().toString().take(8)}",
                name = parsed.toolName,
                args = parsed.args,
            ),
        ),
        stopReason = "tool_use",
    )
    is ParsedEnvelope.Final -> LlmResponse(
        text = parsed.text,
        toolCalls = emptyList(),
        stopReason = "end_turn",
    )
    is ParsedEnvelope.Fallback -> LlmResponse(
        text = parsed.rawText.take(MAX_FINAL_FALLBACK_CHARS).ifBlank { "(empty response)" },
        toolCalls = emptyList(),
        stopReason = "end_turn",
    )
}

/**
 * Heuristic: does this raw output look like the model was cut off
 * mid-sentence by the per-turn token cap? Used by [LocalLlmClient]
 * to decide whether to retry with a continuation prompt before
 * giving up. Conservative on purpose — a false positive costs an
 * extra inference call; a false negative just means we surface the
 * raw text as a final reply, which is the existing behavior.
 */
internal fun looksTruncated(rawText: String): Boolean {
    val trimmed = rawText.trim()
    if (trimmed.isBlank()) return false
    // A balanced object means the model closed at least one
    // envelope — even if it kept padding after, we have what we
    // need; no continuation will improve matters.
    if (extractFirstBalancedObject(trimmed) != null) return false
    // Output that ends mid-token (no closing brace, no terminal
    // punctuation, no quote close) is the canonical truncation
    // signal for envelope-driven prompts.
    val last = trimmed.last()
    return last !in TRUNCATION_OK_TAILS
}

private val TRUNCATION_OK_TAILS = charArrayOf('}', ']', '"', '.', '!', '?')

/** Gemma 4's optional thinking mode wraps reasoning in
 *  `<|think|>...<|/think|>` tokens. Strip the block before envelope
 *  parsing — for legacy models without thinking the markers are
 *  absent and this is a no-op. Mirrors AgentJson.stripThinkingBlock. */
private fun stripThinkingBlock(raw: String): String {
    val open = raw.indexOf(THINK_OPEN)
    if (open < 0) return raw
    val close = raw.indexOf(THINK_CLOSE, startIndex = open + THINK_OPEN.length)
    if (close < 0) return raw
    return raw.removeRange(open, close + THINK_CLOSE.length)
}

/** Best-effort cleanup of small-model JSON output. Strips:
 *  - Markdown code fences
 *  - Leading "Assistant:" residue
 *  - U+201C / U+201D smart quotes → ASCII quotes
 *  - Trailing commas before `}` or `]` */
private fun sanitizeSmallModelJson(s: String): String {
    var out = s.trim()
    if (out.startsWith("```")) {
        val nl = out.indexOf('\n')
        if (nl > 0) out = out.substring(nl + 1)
        val close = out.lastIndexOf("```")
        if (close >= 0) out = out.substring(0, close)
        out = out.trim()
    }
    if (out.startsWith("Assistant:", ignoreCase = true)) {
        out = out.removePrefix("Assistant:").removePrefix("assistant:").trim()
    }
    out = out
        .replace('“', '"')
        .replace('”', '"')
        .replace('‘', '\'')
        .replace('’', '\'')
    out = out.replace(Regex(""",\s*([}\]])"""), "$1")
    return out
}

/** Find the first balanced `{...}` substring. Tolerates leading prose
 *  like `Sure, here it is: {...}` and trailing junk like
 *  `... {...} <end_of_turn>`. */
private fun extractFirstBalancedObject(s: String): String? {
    val start = s.indexOf('{')
    if (start < 0) return null
    var depth = 0
    var inString = false
    var escape = false
    for (i in start until s.length) {
        val c = s[i]
        if (escape) {
            escape = false
            continue
        }
        if (inString) {
            if (c == '\\') escape = true
            else if (c == '"') inString = false
            continue
        }
        when (c) {
            '"' -> inString = true
            '{' -> depth++
            '}' -> {
                depth--
                if (depth == 0) return s.substring(start, i + 1)
            }
        }
    }
    return null
}
