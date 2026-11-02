package dev.orcaxr.nativeapp.mcp.tools

import dev.orcaxr.nativeapp.mcp.McpContext
import dev.orcaxr.nativeapp.mcp.McpJson
import dev.orcaxr.nativeapp.mcp.McpToolRegistry
import dev.orcaxr.nativeapp.mcp.McpToolResult
import dev.orcaxr.nativeapp.prepare.ProcessSettings

/**
 * MCP Tools for inspecting and modifying 3D print process settings (Brim, Supports,
 * Infill, Walls). Accessible by AI agents via MCP and the on-device voice assistant.
 */
object PrintSettingsTools {
    fun register(registry: McpToolRegistry, context: McpContext) {
        registry.registerTool(
            name = "get_print_settings",
            description = "Get the current 3D print process settings including brim (bed adhesion), supports, infill, and wall loops.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")

            val workspace = project.workspace
            val snapshot = try {
                workspace.projectSettingsOverrideSnapshot().get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to read settings snapshot: ${t.message}")
            }

            val settings = ProcessSettings.resolve(snapshot)
            val settingsMap = mapOf(
                "brim_type" to settings.brimType,
                "is_brim_disabled" to settings.isBrimDisabled,
                "brim_width_mm" to settings.brimWidthMm,
                "brim_object_gap_mm" to settings.brimObjectGapMm,
                "enable_support" to settings.enableSupport,
                "support_type" to settings.supportType,
                "support_style" to settings.supportStyle,
                "support_on_build_plate_only" to settings.supportOnBuildPlateOnly,
                "support_threshold_angle" to settings.supportThresholdAngle,
                "support_top_z_distance_mm" to settings.supportTopZDistanceMm,
                "sparse_infill_density" to settings.sparseInfillDensity,
                "wall_loops" to settings.wallLoops,
                "has_overrides" to settings.hasOverrides,
                "total_overrides_count" to settings.totalOverridesCount,
            )

            McpToolResult.text(McpJson.stringify(settingsMap, indent = 2))
        }

        registry.registerTool(
            name = "update_print_settings",
            description = "Update 3D print process settings such as disabling or configuring brim, toggling supports (tree/normal), infill, or walls.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "brim_type" to mapOf(
                        "type" to "string",
                        "description" to "Brim adhesion type: 'no_brim' (disabled), 'auto_brim', 'outer_only', 'inner_only', 'outer_and_inner', or 'brim_ears'.",
                        "enum" to listOf("no_brim", "auto_brim", "outer_only", "inner_only", "outer_and_inner", "brim_ears"),
                    ),
                    "brim_width_mm" to mapOf(
                        "type" to "number",
                        "description" to "Brim width in millimeters (e.g. 5.0).",
                    ),
                    "enable_support" to mapOf(
                        "type" to "boolean",
                        "description" to "Enable or disable support generation.",
                    ),
                    "support_type" to mapOf(
                        "type" to "string",
                        "description" to "Support structure type: 'normal(auto)', 'tree(auto)', 'normal(manual)', or 'tree(manual)'.",
                        "enum" to listOf("normal(auto)", "tree(auto)", "normal(manual)", "tree(manual)"),
                    ),
                    "support_style" to mapOf(
                        "type" to "string",
                        "description" to "Support pattern style: 'default', 'snug', 'tree_slim', 'tree_strong', 'tree_hybrid', or 'organic'.",
                        "enum" to listOf("default", "snug", "tree_slim", "tree_strong", "tree_hybrid", "organic"),
                    ),
                    "support_on_build_plate_only" to mapOf(
                        "type" to "boolean",
                        "description" to "Whether supports should only start from the build plate (not on model surfaces).",
                    ),
                    "support_threshold_angle" to mapOf(
                        "type" to "number",
                        "description" to "Overhang angle threshold in degrees for generating support (e.g. 30.0).",
                    ),
                    "sparse_infill_density" to mapOf(
                        "type" to "string",
                        "description" to "Sparse infill density percentage (e.g. '15%').",
                    ),
                    "wall_loops" to mapOf(
                        "type" to "integer",
                        "description" to "Number of wall perimeters/loops (e.g. 2).",
                    ),
                    "reset_overrides" to mapOf(
                        "type" to "boolean",
                        "description" to "If true, resets all process overrides back to the active preset defaults.",
                    ),
                ),
                "additionalProperties" to false,
            ),
        ) { args ->
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")

            val workspace = project.workspace
            val snapshot = try {
                workspace.projectSettingsOverrideSnapshot().get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to read settings snapshot: ${t.message}")
            }

            var nextOverrides = snapshot.overridesJson
            val appliedChanges = mutableListOf<String>()

            if (args["reset_overrides"] == true) {
                nextOverrides = ProcessSettings.withoutOverrides(nextOverrides)
                appliedChanges.add("Reset all process overrides to profile defaults")
            }

            (args["brim_type"] as? String)?.let { type ->
                nextOverrides = ProcessSettings.withValue(nextOverrides, ProcessSettings.KEY_BRIM_TYPE, type)
                appliedChanges.add("brim_type = $type")
            }

            (args["brim_width_mm"] as? Number)?.let { width ->
                nextOverrides = ProcessSettings.withValue(nextOverrides, ProcessSettings.KEY_BRIM_WIDTH, width)
                appliedChanges.add("brim_width = ${width}mm")
            }

            (args["enable_support"] as? Boolean)?.let { enable ->
                nextOverrides = ProcessSettings.withValue(nextOverrides, ProcessSettings.KEY_ENABLE_SUPPORT, if (enable) "1" else "0")
                appliedChanges.add("enable_support = $enable")
            }

            (args["support_type"] as? String)?.let { type ->
                nextOverrides = ProcessSettings.withValue(nextOverrides, ProcessSettings.KEY_SUPPORT_TYPE, type)
                appliedChanges.add("support_type = $type")
            }

            (args["support_style"] as? String)?.let { style ->
                nextOverrides = ProcessSettings.withValue(nextOverrides, ProcessSettings.KEY_SUPPORT_STYLE, style)
                appliedChanges.add("support_style = $style")
            }

            (args["support_on_build_plate_only"] as? Boolean)?.let { onPlate ->
                nextOverrides = ProcessSettings.withValue(nextOverrides, ProcessSettings.KEY_SUPPORT_ON_BUILD_PLATE_ONLY, if (onPlate) "1" else "0")
                appliedChanges.add("support_on_build_plate_only = $onPlate")
            }

            (args["support_threshold_angle"] as? Number)?.let { angle ->
                nextOverrides = ProcessSettings.withValue(nextOverrides, ProcessSettings.KEY_SUPPORT_THRESHOLD_ANGLE, angle)
                appliedChanges.add("support_threshold_angle = ${angle}°")
            }

            (args["sparse_infill_density"] as? String)?.let { infill ->
                val formatted = if (infill.endsWith("%")) infill else "$infill%"
                nextOverrides = ProcessSettings.withValue(nextOverrides, ProcessSettings.KEY_SPARSE_INFILL_DENSITY, formatted)
                appliedChanges.add("sparse_infill_density = $formatted")
            }

            (args["wall_loops"] as? Number)?.let { walls ->
                nextOverrides = ProcessSettings.withValue(nextOverrides, ProcessSettings.KEY_WALL_LOOPS, walls.toInt())
                appliedChanges.add("wall_loops = ${walls.toInt()}")
            }

            if (appliedChanges.isEmpty()) {
                return@registerTool McpToolResult.error("No valid settings updates were provided.")
            }

            try {
                workspace.applyProjectSettingsOverrides(
                    inheritedConfigJson = snapshot.inheritedConfigJson,
                    overridesJson = nextOverrides,
                    sourceRevision = snapshot.sourceRevision,
                    sourceHash = snapshot.sourceHash,
                ).get()
                project.refreshPrintSettings()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to commit settings update: ${t.message}")
            }

            McpToolResult.text("Successfully updated print process settings:\n" + appliedChanges.joinToString("\n• ", prefix = "• "))
        }
    }
}
