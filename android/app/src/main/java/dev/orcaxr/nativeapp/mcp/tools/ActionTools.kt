package dev.orcaxr.nativeapp.mcp.tools

import dev.orcaxr.core.ProjectActionState
import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.nativeapp.mcp.McpContext
import dev.orcaxr.nativeapp.mcp.McpJson
import dev.orcaxr.nativeapp.mcp.McpToolRegistry
import dev.orcaxr.nativeapp.mcp.McpToolResult
import dev.orcaxr.nativeapp.shell.AppActions

object ActionTools {
    fun register(registry: McpToolRegistry, context: McpContext) {
        registry.registerTool(
            name = "get_action_capabilities",
            description = "Query available slicer/project actions, their enablement status, and reasons when disabled.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "action_ids" to mapOf(
                        "type" to "array",
                        "items" to mapOf("type" to "string"),
                        "description" to "Optional filter list of action IDs to check. If omitted, checks standard actions.",
                    ),
                ),
                "additionalProperties" to false,
            ),
        ) { args ->
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")

            @Suppress("UNCHECKED_CAST")
            val filter = (args["action_ids"] as? List<String>)?.toSet()

            val actionsFuture = project.surfaceActions(ProjectIntents.ActionSurface.CommandPalette)
            val actions = try {
                actionsFuture.get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Could not query actions: ${t.message}")
            }

            val appActions = listOf(
                ProjectActionState("help_mcp_settings", "help_mcp_settings", enabled = true),
                ProjectActionState("help_ai_assistant", "help_ai_assistant", enabled = true),
            )
            val allActions = actions + appActions
            val filtered = if (filter != null) {
                allActions.filter { it.id in filter }
            } else {
                allActions.filter { it.id in AppActions.PERFORMED }
            }

            val list = filtered.map { action ->
                mapOf(
                    "id" to action.id,
                    "label" to action.label,
                    "enabled" to action.enabled,
                    "reason" to action.reason,
                )
            }

            McpToolResult.text(McpJson.stringify(mapOf("actions" to list), indent = 2))
        }

        registry.registerTool(
            name = "invoke_action",
            description = "Invoke a canonical action (e.g. arrange_all, center_on_plate, drop_to_bed, edit_undo, edit_redo, split_to_objects, repair_model, mesh_boolean_union, add_plate, duplicate_plate, delete_plate).",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "action_id" to mapOf(
                        "type" to "string",
                        "description" to "The canonical action identifier to perform.",
                    ),
                ),
                "required" to listOf("action_id"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val actionId = args["action_id"] as? String
                ?: return@registerTool McpToolResult.error("Missing required parameter: action_id")

            if (actionId !in AppActions.PERFORMED && !AppActions.needsPrepare(actionId)) {
                return@registerTool McpToolResult.error("Action '$actionId' is not a performed application action.")
            }

            val executed = context.runAction(actionId)
            if (executed) {
                McpToolResult.text("Successfully executed action: $actionId")
            } else {
                McpToolResult.error("Failed to execute action: $actionId")
            }
        }

        registry.registerTool(
            name = "select_entities",
            description = "Select objects, parts, or instances by row key in the project tree.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "row_key" to mapOf(
                        "type" to "string",
                        "description" to "The key/id of the tree row to select.",
                    ),
                ),
                "required" to listOf("row_key"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val rowKey = args["row_key"] as? String
                ?: return@registerTool McpToolResult.error("Missing required parameter: row_key")

            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")

            context.runOnMain {
                project.selectRow(rowKey, ProjectIntents.ObjectTreeSelectionMode.Replace)
            }

            McpToolResult.text("Selected row: $rowKey")
        }

        registry.registerTool(
            name = "deselect_all",
            description = "Deselect all currently selected models, parts, or plates.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val executed = context.runAction("edit_deselect_all")
            if (executed) {
                McpToolResult.text("Deselected all entities.")
            } else {
                McpToolResult.error("Failed to deselect all entities.")
            }
        }
    }
}
