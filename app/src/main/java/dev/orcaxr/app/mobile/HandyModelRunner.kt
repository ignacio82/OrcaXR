package dev.orcaxr.app.mobile

import android.content.Context
import dev.orcaxr.app.HandyModel
import dev.orcaxr.app.HandyModelCatalog
import dev.orcaxr.app.ToolDispatch
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.WorkspaceModel
import dev.orcaxr.app.mcp.tools.HandyModelTools
import org.json.JSONObject

/**
 * UI-facing wrapper over the `add_handy_model` MCP tool. This is the
 * one model-loading tool that already works on the phone in-process —
 * it terminates in `WorkspaceAction.LoadModelFromPath`, the single
 * Tier-B action `MobileWorkspaceBinding` wires — so a phone picker
 * needs no binding change ([[feedback_ui_mcp_parity]]).
 */
internal object HandyModelRunner {

    /** Bundled catalog — pure, no Context (unit-testable). */
    fun entries(): List<HandyModel> = HandyModelCatalog.ENTRIES

    /**
     * Load a bundled handy model. `replace=true` swaps the workspace;
     * false adds. Routed through the same `add_handy_model` tool the
     * MCP server uses; the emitted `LoadModelFromPath` makes the shell
     * navigate to the Slicer automatically (binding's callback).
     */
    suspend fun add(appContext: Context, id: String, replace: Boolean): ToolDispatch.Result {
        val tool = HandyModelTools.AddHandyModel(WorkspaceModel.get(), ToolContext(appContext))
        val args = JSONObject()
            .put("id", id)
            .put("mode", if (replace) "replace" else "add")
        return ToolDispatch.call(tool, args)
    }
}
