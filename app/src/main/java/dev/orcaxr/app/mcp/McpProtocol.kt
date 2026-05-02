package dev.orcaxr.app.mcp

import org.json.JSONArray
import org.json.JSONObject

/**
 * Protocol-level dispatcher for MCP method calls. The transport layer
 * (HTTP / WebSocket / stdio) hands us already-parsed [JsonRpc.Request]s
 * and we return JSON envelopes ready to write back. No I/O lives here.
 *
 * MCP (Model Context Protocol) spec we target:
 * `2024-11-05` — the stable revision Claude Desktop 1.x speaks. The
 * later `2025-03-26` revision adds `structuredContent` on tool results
 * and elicitation; structuredContent is forward-compatible (older
 * clients ignore unknown keys), elicitation we don't implement yet.
 *
 * Methods we implement:
 * - `initialize` — handshake, advertises server capabilities.
 * - `notifications/initialized` — accept the client's ack, no body.
 * - `tools/list` — enumerate registered [Tool]s.
 * - `tools/call` — invoke one and return its [ToolResult].
 * - `ping` — liveness probe (no-op result).
 *
 * Anything else falls through to METHOD_NOT_FOUND so unknown clients
 * fail loudly rather than hanging.
 */
internal class McpProtocol(
    private val registry: ToolRegistry,
    private val serverName: String,
    private val serverVersion: String,
) {

    /**
     * Dispatch one already-authenticated request. Notifications return
     * `null` (transport must not write a response).
     */
    suspend fun dispatch(req: JsonRpc.Request): JSONObject? {
        return when (req.method) {
            "initialize" -> JsonRpc.ok(req.id, initialize(req.params))
            "notifications/initialized" -> null  // ack from client; nothing to do
            "ping" -> JsonRpc.ok(req.id, JSONObject())
            "tools/list" -> JsonRpc.ok(req.id, toolsList())
            "tools/call" -> {
                val name = req.params.optString("name")
                if (name.isBlank()) {
                    JsonRpc.error(req.id, JsonRpc.INVALID_PARAMS, "tools/call missing 'name'")
                } else {
                    val tool = registry.get(name)
                    if (tool == null) {
                        JsonRpc.error(req.id, JsonRpc.METHOD_NOT_FOUND, "Unknown tool: $name")
                    } else {
                        callTool(req.id, tool, req.params.optJSONObject("arguments") ?: JSONObject())
                    }
                }
            }
            // MCP-spec methods we don't implement yet but might. Return
            // empty results rather than METHOD_NOT_FOUND so a client
            // probing capabilities doesn't bail.
            "resources/list" -> JsonRpc.ok(req.id, JSONObject().apply { put("resources", JSONArray()) })
            "prompts/list" -> JsonRpc.ok(req.id, JSONObject().apply { put("prompts", JSONArray()) })
            else -> {
                if (req.isNotification) null
                else JsonRpc.error(req.id, JsonRpc.METHOD_NOT_FOUND, "Unknown method: ${req.method}")
            }
        }
    }

    private fun initialize(params: JSONObject): JSONObject {
        // We accept whatever protocol version the client asks for (and
        // echo it back) as long as it parses — we're effectively
        // declaring "I'm compatible." If we ever stop being compatible
        // with an older version, tighten this gate.
        val requestedVersion = params.optString("protocolVersion", "2024-11-05")
        val out = JSONObject()
        out.put("protocolVersion", requestedVersion)
        val caps = JSONObject()
        caps.put("tools", JSONObject().apply { put("listChanged", false) })
        out.put("capabilities", caps)
        val info = JSONObject()
        info.put("name", serverName)
        info.put("version", serverVersion)
        out.put("serverInfo", info)
        return out
    }

    private fun toolsList(): JSONObject {
        val arr = JSONArray()
        for (t in registry.list()) {
            val obj = JSONObject()
            obj.put("name", t.name)
            obj.put("description", t.description)
            obj.put("inputSchema", t.inputSchema)
            arr.put(obj)
        }
        val out = JSONObject()
        out.put("tools", arr)
        return out
    }

    private suspend fun callTool(id: Any?, tool: Tool, args: JSONObject): JSONObject {
        return try {
            val result = tool.call(args)
            JsonRpc.ok(id, result.toJson())
        } catch (e: CancellationKt) {
            // CoroutineScope cancellation must not be swallowed.
            throw e
        } catch (e: Throwable) {
            // Tool threw unexpectedly. Surface as JSON-RPC-level error
            // (vs. the in-content `isError: true`) so the client sees
            // it failed at the protocol layer — these are bugs, not
            // user-visible "the tool ran and returned an error".
            JsonRpc.error(
                id,
                JsonRpc.TOOL_FAILED,
                "Tool '${tool.name}' threw: ${e.message ?: e::class.simpleName}",
            )
        }
    }
}

// Alias kept so the catch above stays readable while still letting
// CancellationException propagate; we can't reference
// kotlinx.coroutines.CancellationException directly inside `catch`
// without making this file depend on coroutines, so go through the
// platform CancellationException superclass instead.
private typealias CancellationKt = java.util.concurrent.CancellationException
