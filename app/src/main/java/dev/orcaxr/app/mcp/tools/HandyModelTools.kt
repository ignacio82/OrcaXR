package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.HandyModelCatalog
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject

/**
 * D13 — MCP surface for the bundled "handy model" library.
 *
 * `list_handy_models` enumerates the catalog so the LLM can offer the
 * user a choice. `add_handy_model` stages the bundled asset into
 * cacheDir and routes through [WorkspaceAction.LoadModelFromPath] —
 * GLB bake, paint restore, bed-fit and bed-collision all run
 * identically to a user-picked file.
 */
internal object HandyModelTools {

    fun all(ctx: ToolContext): List<Tool> {
        val workspace = WorkspaceModel.get()
        return listOf(
            ListHandyModels(),
            AddHandyModel(workspace, ctx),
        )
    }

    class ListHandyModels : Tool {
        override val name = "list_handy_models"
        override val description =
            "Enumerate the bundled calibration / reference prints (3DBenchy, Orca Cube, " +
                "Voron Cube, Stanford Bunny, …). Use add_handy_model with the returned id " +
                "to drop one onto the bed."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            val arr = JSONArray()
            for (m in HandyModelCatalog.ENTRIES) {
                arr.put(JSONObject().apply {
                    put("id", m.id)
                    put("display_name", m.displayName)
                    put("hint", m.hint)
                    put("file_name", m.fileName)
                })
            }
            val text = HandyModelCatalog.ENTRIES.joinToString("\n") {
                "${it.id}: ${it.displayName} — ${it.hint}"
            }
            return ToolResult.ok(text, JSONObject().apply {
                put("ok", true)
                put("count", HandyModelCatalog.ENTRIES.size)
                put("models", arr)
            })
        }
    }

    class AddHandyModel(
        private val ws: WorkspaceModel,
        private val ctx: ToolContext,
    ) : Tool {
        override val name = "add_handy_model"
        override val description =
            "Drop a bundled calibration model onto the bed by id (see list_handy_models). " +
                "mode='replace' (default) clears the current bed; mode='add' appends to the " +
                "existing models. The asset is staged to cacheDir on first use, then routed " +
                "through the same load path the file picker uses."
        override val inputSchema = Schemas.obj(
            required = listOf("id"),
            properties = mapOf(
                "id" to Schemas.string(
                    "Handy model id (benchy / orca_cube / voron_cube / stanford_bunny / …)",
                ),
                "mode" to Schemas.string("'replace' (default) or 'add'"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optString("id").trim()
            if (id.isEmpty()) return ToolResult.error("'id' is required.")
            val model = HandyModelCatalog.byId(id)
                ?: return ToolResult.error(
                    "Unknown handy model id '$id'. Use list_handy_models to enumerate.",
                )
            val mode = when (args.optString("mode", "replace").lowercase()) {
                "replace", "" -> WorkspaceAction.LoadMode.Replace
                "add", "append" -> WorkspaceAction.LoadMode.Add
                else -> return ToolResult.error("Mode must be 'replace' or 'add'.")
            }
            if (!ws.attached.value) {
                return ToolResult.error(
                    "OrcaXR's main window isn't attached. Bring the app to the foreground.",
                )
            }
            val staged = runCatching { HandyModelCatalog.stage(ctx.appContext, model) }
                .getOrElse {
                    return ToolResult.error("Failed to stage ${model.id}: ${it.message}")
                }

            ws.emit(WorkspaceAction.LoadModelFromPath(staged.absolutePath, mode))
            return ToolResult.ok(
                "Loading ${model.displayName} (mode=${mode.name.lowercase()}).",
                JSONObject().apply {
                    put("ok", true)
                    put("id", model.id)
                    put("display_name", model.displayName)
                    put("source_path", staged.absolutePath)
                    put("size_bytes", staged.length())
                    put("mode", mode.name.lowercase())
                },
            )
        }
    }
}
