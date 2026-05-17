package dev.orcaxr.app

import dev.orcaxr.app.mcp.Tool
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Shared in-process MCP-tool dispatch — the foundation for UI ⇄ MCP
 * parity ([[feedback_ui_mcp_parity]]). Any phone or XR affordance that
 * needs to perform an MCP-reachable action builds the args and calls
 * the same `Tool` the network MCP server would, off the main thread.
 *
 * Generalizes the pattern proven by `SmartPaintRunner`: UI behavior is
 * identical to the MCP path by construction (one `Tool.call`), and the
 * thin dispatch is unit-testable with a fake `Tool` (no Context, no
 * Compose) — see `ToolDispatchTest`.
 */
internal object ToolDispatch {

    data class Result(val ok: Boolean, val message: String, val structured: JSONObject?) {
        /** Convenience for one-shot UI status strings. */
        fun toStatus(): String = (if (ok) "✓ " else "✗ ") + message
    }

    suspend fun call(tool: Tool, args: JSONObject = JSONObject()): Result =
        withContext(Dispatchers.IO) {
            val res = runCatching { tool.call(args) }.getOrElse {
                return@withContext Result(false, "${tool.name} failed: ${it.message}", null)
            }
            Result(!res.isError, res.text, res.structured)
        }
}
