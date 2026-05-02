package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject

/**
 * Recent-files + plate tools. The recents list backs the empty-state
 * import carousel; plates are the multi-print workspace concept.
 */
internal object RecentTools {

    fun all(ctx: ToolContext): List<Tool> = listOf(
        ListRecentFiles(ctx),
        ClearRecentFiles(ctx),
        RemoveRecentFile(ctx),
        ListPlates(ctx),
        AddPlate(ctx),
        RenamePlate(ctx),
        DeletePlate(ctx),
    )

    class ListRecentFiles(private val ctx: ToolContext) : Tool {
        override val name = "list_recent_files"
        override val description =
            "Recently-opened model files (3MF/STL/OBJ), newest-first. The 'valid' flag is " +
                "true iff the file still exists on disk; stale entries can be removed via remove_recent_file."
        override val inputSchema = Schemas.obj(
            properties = mapOf("only_valid" to Schemas.bool("If true, hide entries whose file no longer exists.")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val onlyValid = args.optBoolean("only_valid", false)
            val all = ctx.recents.all.first()
            val valid = ctx.recents.validRecents.first().map { it.path }.toSet()
            val out = if (onlyValid) all.filter { it.path in valid } else all
            val arr = JSONArray()
            for (r in out) {
                val obj = JSONObject()
                obj.put("path", r.path)
                obj.put("label", r.label)
                obj.put("opened_at_ms", r.openedAtMs)
                obj.put("valid", r.path in valid)
                arr.put(obj)
            }
            val body = JSONObject().apply {
                put("ok", true)
                put("count", out.size)
                put("recents", arr)
            }
            val text = if (out.isEmpty()) "No recent files."
                else out.joinToString("\n") { "- ${it.label}  (${if (it.path in valid) "valid" else "missing"})  ${it.path}" }
            return ToolResult.ok(text, body)
        }
    }

    class ClearRecentFiles(private val ctx: ToolContext) : Tool {
        override val name = "clear_recent_files"
        override val description = "Wipe the entire recent-files list."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            ctx.recents.clear()
            return ToolResult.ok("Recents cleared.", JSONObject().apply { put("ok", true) })
        }
    }

    class RemoveRecentFile(private val ctx: ToolContext) : Tool {
        override val name = "remove_recent_file"
        override val description = "Remove one entry from the recents list by absolute path."
        override val inputSchema = Schemas.obj(
            required = listOf("path"),
            properties = mapOf("path" to Schemas.string("Absolute file path to forget")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val path = args.optString("path").trim()
            if (path.isEmpty()) return ToolResult.error("'path' is required.")
            ctx.recents.remove(path)
            return ToolResult.ok("Removed '$path' from recents.", JSONObject().apply { put("ok", true) })
        }
    }

    // -------- plates --------

    class ListPlates(private val ctx: ToolContext) : Tool {
        override val name = "list_plates"
        override val description =
            "List virtual build plates. Plate id=1 is always present and cannot be deleted; user-added plates " +
                "have higher ids. The 'active' plate (the one displayed in the Plate tab) lives in workspace state — " +
                "see get_workspace_state once that tool ships."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            val plates = ctx.plates.plates.first()
            val arr = JSONArray()
            for (p in plates) {
                val obj = JSONObject()
                obj.put("id", p.id)
                obj.put("label", p.label)
                obj.put("created_at_ms", p.createdAt)
                arr.put(obj)
            }
            val body = JSONObject().apply {
                put("ok", true)
                put("count", plates.size)
                put("plates", arr)
            }
            val text = plates.joinToString("\n") { "- ${it.id}: ${it.label}" }
            return ToolResult.ok(text.ifEmpty { "(no plates)" }, body)
        }
    }

    class AddPlate(private val ctx: ToolContext) : Tool {
        override val name = "add_plate"
        override val description =
            "Add a new virtual plate. The id auto-increments to one above the current max. " +
                "Returns the new plate's id and label."
        override val inputSchema = Schemas.obj(
            required = listOf("label"),
            properties = mapOf("label" to Schemas.string("Display label, e.g. 'Batch B', 'PETG plate'")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val label = args.optString("label").trim()
            if (label.isEmpty()) return ToolResult.error("'label' is required.")
            val plates = ctx.plates.plates.first()
            val nextId = (plates.maxOfOrNull { it.id } ?: 1) + 1
            val plate = dev.orcaxr.app.PlateMetadata(id = nextId, label = label)
            ctx.plates.upsert(plate)
            return ToolResult.ok(
                "Added plate $nextId '$label'.",
                JSONObject().apply { put("ok", true); put("id", nextId); put("label", label) },
            )
        }
    }

    class RenamePlate(private val ctx: ToolContext) : Tool {
        override val name = "rename_plate"
        override val description = "Change a plate's display label."
        override val inputSchema = Schemas.obj(
            required = listOf("id", "label"),
            properties = mapOf(
                "id" to Schemas.integer("Plate id"),
                "label" to Schemas.string("New display label"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optInt("id", -1)
            val label = args.optString("label").trim()
            if (id < 1 || label.isEmpty()) return ToolResult.error("'id' and 'label' are required.")
            val plates = ctx.plates.plates.first()
            val current = plates.firstOrNull { it.id == id }
                ?: return ToolResult.error("No plate with id $id.")
            ctx.plates.upsert(current.copy(label = label))
            return ToolResult.ok(
                "Renamed plate $id to '$label'.",
                JSONObject().apply { put("ok", true); put("id", id); put("label", label) },
            )
        }
    }

    class DeletePlate(private val ctx: ToolContext) : Tool {
        override val name = "delete_plate"
        override val description = "Delete a plate. Plate id=1 cannot be deleted (no-op)."
        override val inputSchema = Schemas.obj(
            required = listOf("id"),
            properties = mapOf("id" to Schemas.integer("Plate id")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optInt("id", -1)
            if (id < 1) return ToolResult.error("'id' is required.")
            if (id == 1) return ToolResult.error("Plate 1 cannot be deleted.")
            ctx.plates.delete(id)
            return ToolResult.ok(
                "Deleted plate $id.",
                JSONObject().apply { put("ok", true); put("deleted_id", id) },
            )
        }
    }
}
