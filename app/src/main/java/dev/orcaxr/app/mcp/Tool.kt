package dev.orcaxr.app.mcp

import org.json.JSONArray
import org.json.JSONObject

/**
 * One MCP tool. The MCP spec requires three things in `tools/list`:
 * `name`, `description`, and an `inputSchema` (JSON Schema) describing
 * the arguments the tool takes. The shape we hand back from a
 * `tools/call` invocation is a `CallToolResult` — see [ToolResult].
 *
 * Implementations are responsible for validating their own params (the
 * JSON-RPC layer can only catch parse / type errors; it can't know that
 * a given tool requires a specific printer id). On invalid input,
 * return [ToolResult.error] rather than throwing — exceptions get
 * promoted to JSON-RPC -32002 (TOOL_FAILED) by the dispatcher, which
 * is the right shape for *unexpected* failures but wrong for routine
 * "the user/LLM passed a bad arg" cases.
 */
interface Tool {
    val name: String
    val description: String

    /**
     * JSON Schema for the `arguments` object the tool expects. MCP
     * clients (Claude Desktop, the Anthropic SDK's tool router, etc.)
     * read this to build typed call sites. Always include "type":
     * "object" plus a "properties" map; required fields go in
     * "required" array.
     */
    val inputSchema: JSONObject

    suspend fun call(args: JSONObject): ToolResult
}

/**
 * What a tool returns. Maps onto MCP's `CallToolResult`:
 * - `content` is an array of typed parts (text, image, resource…); we
 *   only emit "text" parts here — every Orca tool's output flattens to
 *   structured JSON or human-readable text.
 * - `structuredContent` carries the machine-parseable shape (added in
 *   the 2025-03-26 spec revision). The LLM client gets BOTH: the text
 *   for prompting context, the structured form for tool chaining.
 * - `isError = true` is how MCP signals that a tool *ran* but produced
 *   an error result (vs. the protocol-level JSON-RPC error which
 *   indicates the call itself failed).
 */
data class ToolResult(
    val text: String,
    val structured: JSONObject? = null,
    val isError: Boolean = false,
    /**
     * Optional image content parts (C9 milestone 2 — vision pillar).
     * Each entry is a base64-encoded PNG; the dispatcher renders it as
     * an `{type:"image", source:{type:"base64", media_type:"image/png",
     * data:"..."}}` MCP content part. Keep small (≤200 KB encoded) —
     * larger images should be served via the `/resources/<token>.png`
     * route, with the URI surfaced in [structured].
     */
    val imageParts: List<ImagePart> = emptyList(),
) {
    fun toJson(): JSONObject {
        val out = JSONObject()
        val arr = JSONArray()
        val textPart = JSONObject()
        textPart.put("type", "text")
        textPart.put("text", text)
        arr.put(textPart)
        for (img in imageParts) {
            val part = JSONObject()
            part.put("type", "image")
            part.put("mimeType", img.mediaType)
            part.put("data", img.base64Data)
            arr.put(part)
        }
        out.put("content", arr)
        if (structured != null) out.put("structuredContent", structured)
        if (isError) out.put("isError", true)
        return out
    }

    /** Single image content part. */
    data class ImagePart(val mediaType: String, val base64Data: String)

    companion object {
        fun ok(text: String, structured: JSONObject? = null): ToolResult =
            ToolResult(text, structured, isError = false)

        fun ok(text: String, structured: JSONObject?, imageParts: List<ImagePart>): ToolResult =
            ToolResult(text, structured, isError = false, imageParts = imageParts)

        fun error(text: String, data: JSONObject? = null): ToolResult =
            ToolResult(text, data, isError = true)
    }
}

/**
 * Tiny in-memory registry. Tools register themselves at server-build
 * time (see [McpServer.Builder]); the dispatcher looks them up by name
 * on every `tools/call`. LinkedHashMap preserves registration order,
 * which is what `tools/list` returns — clients render the list to the
 * LLM in the order it arrives, so deterministic order helps prompt
 * stability across runs.
 */
class ToolRegistry {
    private val tools = LinkedHashMap<String, Tool>()

    fun register(tool: Tool) {
        tools[tool.name] = tool
    }

    fun list(): List<Tool> = tools.values.toList()

    fun get(name: String): Tool? = tools[name]
}

/**
 * Common JSON Schema fragments. We hand-roll these because the
 * `org.json` API doesn't have a builder DSL and we don't want to drag
 * in a JSON Schema library for what amounts to ~30 short schemas.
 */
internal object Schemas {
    fun obj(
        required: List<String> = emptyList(),
        properties: Map<String, JSONObject> = emptyMap(),
        additionalProperties: Boolean = false,
    ): JSONObject {
        val out = JSONObject()
        out.put("type", "object")
        if (properties.isNotEmpty()) {
            val props = JSONObject()
            for ((k, v) in properties) props.put(k, v)
            out.put("properties", props)
        }
        if (required.isNotEmpty()) {
            val arr = JSONArray()
            for (r in required) arr.put(r)
            out.put("required", arr)
        }
        out.put("additionalProperties", additionalProperties)
        return out
    }

    fun string(description: String): JSONObject {
        val out = JSONObject()
        out.put("type", "string")
        out.put("description", description)
        return out
    }

    fun integer(description: String): JSONObject {
        val out = JSONObject()
        out.put("type", "integer")
        out.put("description", description)
        return out
    }

    fun number(description: String): JSONObject {
        val out = JSONObject()
        out.put("type", "number")
        out.put("description", description)
        return out
    }

    fun bool(description: String): JSONObject {
        val out = JSONObject()
        out.put("type", "boolean")
        out.put("description", description)
        return out
    }

    fun stringArray(description: String): JSONObject {
        val out = JSONObject()
        out.put("type", "array")
        out.put("description", description)
        out.put("items", string(""))
        return out
    }

    fun empty(): JSONObject = obj()
}
