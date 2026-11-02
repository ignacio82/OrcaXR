package dev.orcaxr.nativeapp.mcp.tools

import android.os.Build
import dev.orcaxr.nativeapp.mcp.McpContext
import dev.orcaxr.nativeapp.mcp.McpJson
import dev.orcaxr.nativeapp.mcp.McpToolRegistry
import dev.orcaxr.nativeapp.mcp.McpToolResult

object SystemTools {
    fun register(registry: McpToolRegistry, context: McpContext) {
        registry.registerTool(
            name = "get_system_info",
            description = "Get runtime system, OS, hardware, and engine information for OrcaXR Android.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val info = mapOf(
                "app" to "OrcaXR Android",
                "version" to "0.1.0-dev",
                "os" to "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
                "device" to "${Build.MANUFACTURER} ${Build.MODEL}",
                "hardware" to Build.HARDWARE,
                "supported_abis" to Build.SUPPORTED_ABIS.toList(),
            )
            McpToolResult.text(McpJson.stringify(info, indent = 2))
        }

        registry.registerTool(
            name = "ping",
            description = "Check connectivity and round-trip latency to the Android MCP server.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val reply = mapOf(
                "status" to "pong",
                "timestamp" to System.currentTimeMillis(),
            )
            McpToolResult.text(McpJson.stringify(reply, indent = 2))
        }

        registry.registerTool(
            name = "get_ai_status",
            description = "Query status of the on-device AI LLM engines (Google Tensor TPU / Gemini Nano and LiteRT Gemma).",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val app = context.project?.getApplication<android.app.Application>() ?: return@registerTool McpToolResult.error("App context unavailable")
            val modelManager = dev.orcaxr.nativeapp.ai.LlmModelManager.getInstance(app)
            val engine = modelManager.activeEngine.value
            val aicore = modelManager.aiCoreStatus.value
            val dl = modelManager.downloadState.value

            val info = mapOf(
                "active_engine" to (engine?.backendName ?: "None"),
                "backend_kind" to (engine?.backendKind?.name ?: "NONE"),
                "aicore_tpu_status" to aicore.toString(),
                "litert_download_status" to dl.toString(),
            )
            McpToolResult.text(McpJson.stringify(info, indent = 2))
        }

        registry.registerTool(
            name = "ask_local_ai",
            description = "Ask the on-device local AI (Google Tensor TPU / Gemini Nano or Gemma) a natural language instruction to execute slicer/workspace operations or answer queries.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "prompt" to mapOf(
                        "type" to "string",
                        "description" to "Natural language prompt/command for the on-device LLM.",
                    ),
                ),
                "required" to listOf("prompt"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val prompt = args["prompt"] as? String ?: return@registerTool McpToolResult.error("Missing prompt")
            val app = context.project?.getApplication<android.app.Application>() ?: return@registerTool McpToolResult.error("App context unavailable")
            val assistant = dev.orcaxr.nativeapp.ai.OrcaAiAssistant(app)
            val response = assistant.query(prompt)
            val result = mapOf(
                "text" to response.text,
                "tool_called" to response.toolCall?.name,
                "tool_args" to response.toolCall?.arguments,
                "tool_result" to response.toolResultText,
                "is_error" to response.isError,
            )
            McpToolResult.text(McpJson.stringify(result, indent = 2), isError = response.isError)
        }
    }
}
