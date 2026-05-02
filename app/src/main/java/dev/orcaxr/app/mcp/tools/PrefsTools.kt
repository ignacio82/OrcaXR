package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import org.json.JSONObject

/**
 * User-preferences tools. These cover the small SharedPreferences-backed
 * settings: last-selected profile id, last-selected printer id,
 * layer-height override, show-travels toggle, toolpath-tubes toggle.
 *
 * The "last selected" ids are read-only here — flipping the live UI
 * selection requires the WorkspaceModel mutator path (next commit).
 * Setting them via this tool DOES affect the next app launch (because
 * MainActivity reads `lastProfileOrDefault` / `lastPrinterId` at
 * startup), so an LLM that wants to pre-arrange the next session can
 * still use this.
 */
internal object PrefsTools {

    fun all(ctx: ToolContext): List<Tool> = listOf(
        GetUserPreferences(ctx),
        SetUserPreference(ctx),
    )

    private fun encode(ctx: ToolContext): JSONObject = JSONObject().apply {
        put("last_profile_id", ctx.prefs.lastProfileId ?: JSONObject.NULL)
        put("last_printer_id", ctx.prefs.lastPrinterId ?: JSONObject.NULL)
        put("layer_height_override", ctx.prefs.layerHeightOverride)
        put("show_travels", ctx.prefs.showTravels)
        put("toolpath_tubes", ctx.prefs.toolpathTubes)
    }

    class GetUserPreferences(private val ctx: ToolContext) : Tool {
        override val name = "get_user_preferences"
        override val description =
            "Read OrcaXR's small persistent preferences: last-selected profile id, last-selected " +
                "printer id, layer-height override (empty string = use profile default), and " +
                "the two toolpath rendering toggles (show_travels, toolpath_tubes)."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            val body = JSONObject().apply {
                put("ok", true)
                put("preferences", encode(ctx))
            }
            return ToolResult.ok(body.toString(), body)
        }
    }

    class SetUserPreference(private val ctx: ToolContext) : Tool {
        override val name = "set_user_preference"
        override val description =
            "Set one persistent preference. Valid keys: " +
                "'last_profile_id' (string), 'last_printer_id' (string, can be null/empty to clear), " +
                "'layer_height_override' (string, empty = use profile default), " +
                "'show_travels' (bool), 'toolpath_tubes' (bool). " +
                "Note: live in-session UI doesn't immediately reflect changes here; the new value " +
                "takes effect on the next launch (or when the user changes the relevant control)."
        override val inputSchema = Schemas.obj(
            required = listOf("key", "value"),
            properties = mapOf(
                "key" to Schemas.string("One of: last_profile_id, last_printer_id, layer_height_override, show_travels, toolpath_tubes"),
                "value" to JSONObject().apply {
                    put("description", "New value (string for ids, bool for toggles).")
                },
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val key = args.optString("key").trim()
            return when (key) {
                "last_profile_id" -> {
                    val v = args.optString("value", "").ifBlank { null }
                    ctx.prefs.lastProfileId = v
                    success(key, v)
                }
                "last_printer_id" -> {
                    val v = args.optString("value", "").ifBlank { null }
                    ctx.prefs.lastPrinterId = v
                    success(key, v)
                }
                "layer_height_override" -> {
                    val v = args.optString("value", "")
                    ctx.prefs.layerHeightOverride = v
                    success(key, v)
                }
                "show_travels" -> {
                    val v = args.optBoolean("value", false)
                    ctx.prefs.showTravels = v
                    success(key, v)
                }
                "toolpath_tubes" -> {
                    val v = args.optBoolean("value", true)
                    ctx.prefs.toolpathTubes = v
                    success(key, v)
                }
                else -> ToolResult.error("Unknown key '$key'.")
            }
        }

        private fun success(key: String, value: Any?): ToolResult {
            val body = JSONObject().apply {
                put("ok", true)
                put("key", key)
                put("value", value ?: JSONObject.NULL)
            }
            return ToolResult.ok("Set $key = $value", body)
        }
    }
}
