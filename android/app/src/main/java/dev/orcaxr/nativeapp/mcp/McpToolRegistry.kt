package dev.orcaxr.nativeapp.mcp

import java.util.concurrent.ConcurrentHashMap

sealed interface McpContent {
    data class Text(val text: String) : McpContent
    data class Image(val data: String, val mimeType: String = "image/png") : McpContent

    fun toMap(): Map<String, Any> = when (this) {
        is Text -> mapOf("type" to "text", "text" to text)
        is Image -> mapOf("type" to "image", "data" to data, "mimeType" to mimeType)
    }
}

data class McpToolResult(
    val content: List<McpContent>,
    val isError: Boolean = false,
) {
    fun toMap(): Map<String, Any> = mapOf(
        "content" to content.map { it.toMap() },
        "isError" to isError,
    )

    companion object {
        fun text(text: String, isError: Boolean = false) =
            McpToolResult(listOf(McpContent.Text(text)), isError)

        fun error(message: String) =
            McpToolResult(listOf(McpContent.Text("Error: $message")), isError = true)

        fun image(data: String, mimeType: String = "image/png") =
            McpToolResult(listOf(McpContent.Image(data, mimeType)), isError = false)
    }
}

data class McpTool(
    val name: String,
    val description: String,
    val inputSchema: Map<String, Any?>,
    val handler: suspend (Map<String, Any?>) -> McpToolResult,
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "name" to name,
        "description" to description,
        "inputSchema" to inputSchema,
    )
}

class McpToolRegistry {
    private val tools = ConcurrentHashMap<String, McpTool>()

    fun registerTool(
        name: String,
        description: String,
        inputSchema: Map<String, Any?>,
        handler: suspend (Map<String, Any?>) -> McpToolResult,
    ) {
        tools[name] = McpTool(name, description, inputSchema, handler)
    }

    fun getTool(name: String): McpTool? = tools[name]

    suspend fun callTool(name: String, args: Map<String, Any?> = emptyMap()): McpToolResult? =
        tools[name]?.handler?.invoke(args)

    fun listTools(): List<McpTool> = tools.values.sortedBy { it.name }
}
