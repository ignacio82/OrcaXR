package dev.orcaxr.app.llm

import android.content.Context
import dev.orcaxr.app.mcp.McpController
import dev.orcaxr.app.mcp.McpServer
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import org.json.JSONObject

/**
 * In-process bridge that exposes the same [Tool] surface the MCP
 * server publishes to the in-app LLM assistant. Reuses
 * [McpController.registerAllTools] so the assistant sees the exact
 * same set of tools an external Claude Desktop client would, with no
 * second registration list to keep in sync.
 *
 * Why not call our own MCP server over loopback HTTP? Two reasons:
 * - It's the same JVM. Going through HTTP just to dispatch to a local
 *   suspending function is silly: extra serialization, an unnecessary
 *   socket roundtrip, and the MCP server doesn't even have to be
 *   *enabled* for the in-app assistant to work.
 * - The MCP server is opt-in. Forcing the user to flip on a feature
 *   they don't want (a LAN-listening service) just to talk to an LLM
 *   from their headset would be a UX trap.
 */
class LlmToolBridge(appContext: Context) {

    private val tools: List<Tool> = run {
        val builder = McpServer.Builder()
            .authToken(null)
            .serverName(McpServer.DEFAULT_NAME)
            .serverVersion(McpServer.DEFAULT_VERSION)
        val ctl = McpController.get(appContext)
        // Reuse the controller's already-built ToolContext so stores
        // are singletons (no torn DataStore reads, etc.).
        McpController.registerAllTools(builder, ctl.toolContext, ctl.settings())
        builder.peekRegisteredTools()
    }

    /** All available tools, in registration order. */
    fun all(): List<Tool> = tools

    /** Names only — useful for compact UI surfaces. */
    fun names(): List<String> = tools.map { it.name }

    /** Tool definitions in the LLM-facing shape. */
    fun toolDefs(): List<LlmToolDef> = tools.map {
        LlmToolDef(name = it.name, description = it.description, inputSchema = it.inputSchema)
    }

    /** Run one tool call by name. Returns null if the name is unknown. */
    suspend fun execute(name: String, args: JSONObject): ToolResult? {
        val tool = tools.firstOrNull { it.name == name } ?: return null
        return try {
            tool.call(args)
        } catch (e: Throwable) {
            ToolResult.error("Tool '$name' threw: ${e.message ?: e.javaClass.simpleName}")
        }
    }
}
