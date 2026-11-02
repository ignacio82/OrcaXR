package dev.orcaxr.nativeapp.mcp.tools

import dev.orcaxr.nativeapp.mcp.McpContext
import dev.orcaxr.nativeapp.mcp.McpJson
import dev.orcaxr.nativeapp.mcp.McpToolRegistry
import dev.orcaxr.nativeapp.mcp.McpToolResult

object SliceTools {
    fun register(registry: McpToolRegistry, context: McpContext) {
        registry.registerTool(
            name = "slice_active_plate",
            description = "Start slicing the currently active build plate using the local or attested external engine.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val prepare = context.prepare
                ?: return@registerTool McpToolResult.error("Prepare / slicing engine is not available.")

            if (prepare.state.job != null) {
                return@registerTool McpToolResult.error("A slicing job is already in progress.")
            }

            context.runOnMain {
                prepare.slice()
            }
            McpToolResult.text("Slicing initiated for active plate. Use 'get_slice_status' to monitor progress.")
        }

        registry.registerTool(
            name = "get_slice_status",
            description = "Check status, progress percent, and phase of current or last slicing job.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val prepare = context.prepare
                ?: return@registerTool McpToolResult.error("Prepare / slicing engine is not available.")

            val job = prepare.state.job
            val result = prepare.state.result

            val statusMap = mapOf(
                "is_slicing" to (job != null),
                "progress_percent" to (job?.percent ?: if (result != null) 100.0 else 0.0),
                "job_message" to (job?.message ?: if (result != null) "Slice ready" else "Idle"),
                "has_result" to (result != null),
                "sliced_plate_name" to (result?.plateName),
                "is_local_engine" to (result?.local ?: false),
            )

            McpToolResult.text(McpJson.stringify(statusMap, indent = 2))
        }

        registry.registerTool(
            name = "get_slice_summary",
            description = "Get slicer estimates (estimated print time, filament usage, layer count) for the sliced model on the active build plate in the slicer editor.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val prepare = context.prepare
                ?: return@registerTool McpToolResult.error("Prepare / slicing engine is not available.")

            val result = prepare.state.result
                ?: return@registerTool McpToolResult.error("No completed slice output is currently available.")

            val summaryMap = mapOf(
                "plate_id" to result.plateId,
                "plate_name" to result.plateName,
                "file_name" to result.name,
                "file_size_bytes" to result.file.length(),
                "summary" to result.summary,
                "row_description" to result.row,
                "is_local_engine" to result.local,
            )

            McpToolResult.text(McpJson.stringify(summaryMap, indent = 2))
        }

        registry.registerTool(
            name = "get_preview_state",
            description = "Get detailed G-code preview metrics (layer count, current layer range, estimated print time, filament weight, filament length, legend, limitations) without needing screenshots.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val preview = context.preview
                ?: return@registerTool McpToolResult.error("Preview model is not available.")

            val prev = preview.state
            val summary = prev.summary

            val legendList = prev.legend.map {
                mapOf(
                    "code" to it.code,
                    "label" to it.label,
                    "argb" to it.argb,
                )
            }

            val previewMap = mapOf(
                "has_gcode" to (prev.source != null),
                "source_file" to prev.source,
                "loading" to prev.loading,
                "layer_count" to prev.layerCount,
                "layer_bounds" to prev.layerBounds?.let { listOf(it.first, it.second) },
                "layer_range" to prev.layerRange?.let { listOf(it.first, it.second) },
                "single_layer" to prev.singleLayer,
                "totals" to summary?.totals,
                "tools" to summary?.tools?.map { mapOf("tool_index" to it.toolIndex, "text" to it.text, "color" to it.colorHex) },
                "withdrawn" to prev.withdrawn,
                "limitations" to prev.limitations,
                "legend" to legendList,
                "mode" to prev.mode,
            )

            McpToolResult.text(McpJson.stringify(previewMap, indent = 2))
        }

        registry.registerTool(
            name = "get_preflight",
            description = "Get slice preflight checks, blockers, warnings, and printability status for the active build plate.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val prepare = context.prepare
                ?: return@registerTool McpToolResult.error("Prepare model is not available.")

            val preflight = prepare.state.preflight
            if (preflight == null) {
                return@registerTool McpToolResult.text(McpJson.stringify(mapOf("has_preflight" to false), indent = 2))
            }

            val cardsList = preflight.cards.map { card ->
                mapOf(
                    "id" to card.id,
                    "error" to card.error,
                    "heading" to card.heading,
                    "message" to card.message,
                    "help" to card.help,
                    "entities" to card.entities,
                )
            }

            val result = mapOf(
                "has_preflight" to true,
                "plate_id" to preflight.plateId,
                "can_slice" to preflight.canSlice,
                "total_issues" to preflight.total,
                "cards" to cardsList,
            )

            McpToolResult.text(McpJson.stringify(result, indent = 2))
        }

        registry.registerTool(
            name = "cancel_slice",
            description = "Cancel the currently executing slicing job.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val prepare = context.prepare
                ?: return@registerTool McpToolResult.error("Prepare / slicing engine is not available.")

            if (prepare.state.job == null) {
                return@registerTool McpToolResult.text("No slicing job is currently running.")
            }

            context.runOnMain {
                prepare.cancel()
            }
            McpToolResult.text("Slicing cancellation requested.")
        }
    }
}
