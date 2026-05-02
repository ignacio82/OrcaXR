package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.SlicerProfile
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject

/**
 * Slicer-profile tools. The picker in the Prepare tab combines two
 * sources: bundled profiles loaded from `assets/profiles/{Snapmaker,
 * Elegoo}/` at startup, and user-defined profiles persisted in
 * `UserProfilesStore`. Both are exposed here.
 */
internal object ProfileTools {

    fun all(ctx: ToolContext): List<Tool> = listOf(
        ListProfiles(ctx),
        ListUserProfiles(ctx),
        DeleteUserProfile(ctx),
    )

    private fun encode(p: SlicerProfile, isUser: Boolean): JSONObject = JSONObject().apply {
        put("id", p.id)
        put("display_name", p.displayName)
        put("description", p.description)
        if (p.machineName != null) put("machine_name", p.machineName)
        if (p.processName != null) put("process_name", p.processName)
        if (p.filamentName != null) put("filament_name", p.filamentName)
        put("is_user_profile", isUser)
        put("config_key_count", p.config.size)
    }

    class ListProfiles(private val ctx: ToolContext) : Tool {
        override val name = "list_profiles"
        override val description =
            "List all slicer profiles available in the picker. Combines bundled profiles " +
                "(Snapmaker, Elegoo) loaded at app startup with user-saved profiles. " +
                "Each entry has id, display_name, description, machine_name, process_name, filament_name, " +
                "and is_user_profile (true for user-saved). Use 'config_key_count' to estimate richness; " +
                "the underlying config map is available via get_profile_config if needed."
        override val inputSchema = Schemas.obj(
            properties = mapOf(
                "filter" to Schemas.string("Optional substring filter applied to display_name (case-insensitive)"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val filter = args.optString("filter").lowercase()
            val bundled = ctx.bundledProfiles.map { it to false }
            val user = ctx.profilesUser.profiles.first().map { it to true }
            val all = (bundled + user).let { items ->
                if (filter.isBlank()) items
                else items.filter { it.first.displayName.lowercase().contains(filter) }
            }
            val arr = JSONArray()
            for ((p, isUser) in all) arr.put(encode(p, isUser))
            val body = JSONObject().apply {
                put("ok", true)
                put("count", all.size)
                put("profiles", arr)
            }
            val text = if (all.isEmpty()) "No profiles match."
                else all.joinToString("\n") { (p, isUser) ->
                    val tag = if (isUser) "[user]" else "[bundled]"
                    "- $tag ${p.displayName}  id=${p.id}"
                }
            return ToolResult.ok(text, body)
        }
    }

    class ListUserProfiles(private val ctx: ToolContext) : Tool {
        override val name = "list_user_profiles"
        override val description =
            "List only the user-saved slicer profiles (not the bundled catalog). " +
                "User profiles can be deleted; bundled cannot."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            val user = ctx.profilesUser.profiles.first()
            val arr = JSONArray()
            for (p in user) arr.put(encode(p, true))
            val body = JSONObject().apply {
                put("ok", true)
                put("count", user.size)
                put("profiles", arr)
            }
            val text = if (user.isEmpty()) "No user profiles saved."
                else user.joinToString("\n") { "- ${it.displayName}  id=${it.id}" }
            return ToolResult.ok(text, body)
        }
    }

    class DeleteUserProfile(private val ctx: ToolContext) : Tool {
        override val name = "delete_user_profile"
        override val description =
            "Delete a user-saved profile. Only operates on user profiles; passing a bundled profile id is a no-op."
        override val inputSchema = Schemas.obj(
            required = listOf("profile_id"),
            properties = mapOf("profile_id" to Schemas.string("User profile id from list_user_profiles")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optString("profile_id").trim()
            if (id.isEmpty()) return ToolResult.error("'profile_id' is required.")
            val user = ctx.profilesUser.profiles.first()
            val target = user.firstOrNull { it.id == id }
                ?: return ToolResult.error("No user profile with id '$id'.")
            ctx.profilesUser.delete(id)
            return ToolResult.ok(
                "Deleted user profile '${target.displayName}'.",
                JSONObject().apply { put("ok", true); put("deleted_id", id) },
            )
        }
    }
}
