package dev.orcaxr.nativeapp.mcp

class McpJsonRpc(
    private val registry: McpToolRegistry,
    private val serverName: String = "OrcaXR Android",
    private val serverVersion: String = "0.1.0",
) {
    suspend fun handleMessage(rawMessage: String): String? {
        val trimmed = rawMessage.trim()
        if (!trimmed.startsWith("{")) {
            return errorResponse(null, CODE_PARSE_ERROR, "Parse error: expected JSON object")
        }

        val parsed = try {
            McpJson.parse(trimmed)
        } catch (e: Exception) {
            return errorResponse(null, CODE_PARSE_ERROR, "Parse error: ${e.message}")
        }

        @Suppress("UNCHECKED_CAST")
        val request = parsed as? Map<String, Any?>
            ?: return errorResponse(null, CODE_INVALID_REQUEST, "Invalid Request: root must be JSON object")

        val id = request["id"]
        val isNotification = (id == null)

        val jsonrpc = request["jsonrpc"] as? String
        if (jsonrpc != "2.0") {
            return if (isNotification) null else errorResponse(id, CODE_INVALID_REQUEST, "Invalid Request: jsonrpc must be '2.0'")
        }

        val method = request["method"] as? String
        if (method.isNullOrBlank()) {
            return if (isNotification) null else errorResponse(id, CODE_INVALID_REQUEST, "Missing method")
        }

        return when (method) {
            "initialize" -> {
                val result = mapOf(
                    "protocolVersion" to PROTOCOL_VERSION,
                    "capabilities" to mapOf(
                        "tools" to mapOf("listChanged" to false),
                    ),
                    "serverInfo" to mapOf(
                        "name" to serverName,
                        "version" to serverVersion,
                    ),
                )
                successResponse(id, result)
            }
            "notifications/initialized" -> {
                null
            }
            "ping" -> {
                successResponse(id, emptyMap<String, Any>())
            }
            "tools/list" -> {
                val toolsList = registry.listTools().map { it.toMap() }
                successResponse(id, mapOf("tools" to toolsList))
            }
            "tools/call" -> {
                @Suppress("UNCHECKED_CAST")
                val params = request["params"] as? Map<String, Any?>
                if (params == null) {
                    return errorResponse(id, CODE_INVALID_PARAMS, "Invalid params: params object required")
                }
                val toolName = params["name"] as? String
                if (toolName.isNullOrBlank()) {
                    return errorResponse(id, CODE_INVALID_PARAMS, "Invalid params: tool name required")
                }
                val tool = registry.getTool(toolName)
                    ?: return successResponse(
                        id,
                        McpToolResult.error("Unknown tool: $toolName").toMap(),
                    )

                @Suppress("UNCHECKED_CAST")
                val arguments = (params["arguments"] as? Map<String, Any?>) ?: emptyMap()
                try {
                    val toolResult = tool.handler(arguments)
                    successResponse(id, toolResult.toMap())
                } catch (t: Throwable) {
                    successResponse(
                        id,
                        McpToolResult.error("Execution error: ${t.message ?: t.javaClass.simpleName}").toMap(),
                    )
                }
            }
            else -> {
                if (isNotification) null else errorResponse(id, CODE_METHOD_NOT_FOUND, "Method not found: $method")
            }
        }
    }

    private fun successResponse(id: Any?, result: Any): String {
        val resp = mapOf(
            "jsonrpc" to "2.0",
            "id" to id,
            "result" to result,
        )
        return McpJson.stringify(resp)
    }

    private fun errorResponse(id: Any?, code: Int, message: String): String {
        val resp = mapOf(
            "jsonrpc" to "2.0",
            "id" to id,
            "error" to mapOf(
                "code" to code,
                "message" to message,
            ),
        )
        return McpJson.stringify(resp)
    }

    companion object {
        const val PROTOCOL_VERSION = "2024-11-05"
        const val CODE_PARSE_ERROR = -32700
        const val CODE_INVALID_REQUEST = -32600
        const val CODE_METHOD_NOT_FOUND = -32601
        const val CODE_INVALID_PARAMS = -32602
        const val CODE_INTERNAL_ERROR = -32603
    }
}
