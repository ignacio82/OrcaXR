package dev.orcaxr.app

import android.content.Context
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.tools.SettingsBackupTools
import org.json.JSONObject

/**
 * UI-facing wrapper over the `export_settings` / `import_settings` MCP
 * tools so the phone Settings card and the XR Settings panel restore /
 * back up through the exact same logic the MCP server uses
 * ([[feedback_ui_mcp_parity]]). SAF I/O (content:// URIs) is the
 * caller's job — the tool only produces / consumes the JSON envelope.
 */
internal object SettingsBackupRunner {

    /** Returns the export envelope (pretty JSON) or an error result. */
    suspend fun exportEnvelope(appContext: Context): Pair<ToolDispatch.Result, String?> {
        val ctx = ToolContext(appContext)
        val r = ToolDispatch.call(SettingsBackupTools.ExportSettings(ctx), JSONObject())
        val envelope = r.structured?.optJSONObject("envelope")?.toString(2)
        return r to envelope
    }

    /** Imports a previously-exported envelope (parsed from the user's
     *  chosen file). `replace=false` merges; true clears each store. */
    suspend fun importEnvelope(
        appContext: Context,
        envelopeJson: String,
        replace: Boolean,
    ): ToolDispatch.Result {
        val parsed = runCatching { JSONObject(envelopeJson) }.getOrNull()
            ?: return ToolDispatch.Result(false, "Selected file is not valid settings JSON.", null)
        val ctx = ToolContext(appContext)
        val args = JSONObject()
            .put("envelope", parsed)
            .put("mode", if (replace) "replace" else "merge")
        return ToolDispatch.call(SettingsBackupTools.ImportSettings(ctx), args)
    }
}
