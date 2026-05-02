package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.mcp.McpServer
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import org.json.JSONArray
import org.json.JSONObject

/**
 * Server-introspection tools. These help an LLM client confirm the
 * connection works (echo) and learn what the server can reach
 * (server_info). Both are auth-gated so an unauthorized caller still
 * has to know the bearer token.
 */
internal object SystemTools {

    fun all(ctx: ToolContext): List<Tool> = listOf(
        Echo(),
        ServerInfo(),
    )

    class Echo : Tool {
        override val name = "echo"
        override val description =
            "Round-trip diagnostic: returns the supplied 'message' verbatim. Useful for verifying " +
                "the server is reachable and the bearer-token auth is configured."
        override val inputSchema = Schemas.obj(
            required = listOf("message"),
            properties = mapOf("message" to Schemas.string("Any string")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val msg = args.optString("message", "")
            val body = JSONObject().apply {
                put("ok", true)
                put("message", msg)
            }
            return ToolResult.ok(msg, body)
        }
    }

    class ServerInfo : Tool {
        override val name = "server_info"
        override val description =
            "Describe the OrcaXR MCP server: server name, version, LAN addresses, supported tool " +
                "categories. Use this to verify which features are reachable from this build."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            val ips = JSONArray()
            for (a in McpServer.lanAddresses()) ips.put(a)
            val body = JSONObject().apply {
                put("ok", true)
                put("server_name", McpServer.DEFAULT_NAME)
                put("server_version", McpServer.DEFAULT_VERSION)
                put("lan_addresses", ips)
                val cats = JSONArray()
                cats.put("printers")
                cats.put("profiles")
                cats.put("filaments")
                cats.put("recents")
                cats.put("plates")
                cats.put("preferences")
                put("categories", cats)
            }
            val text = "OrcaXR MCP " + McpServer.DEFAULT_VERSION +
                " — categories: printers, profiles, filaments, recents, plates, preferences"
            return ToolResult.ok(text, body)
        }
    }
}
