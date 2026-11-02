package dev.orcaxr.nativeapp.mcp.tools

import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.nativeapp.mcp.McpContext
import dev.orcaxr.nativeapp.mcp.McpJson
import dev.orcaxr.nativeapp.mcp.McpToolRegistry
import dev.orcaxr.nativeapp.mcp.McpToolResult

object UiTools {
    fun register(registry: McpToolRegistry, context: McpContext) {
        registry.registerTool(
            name = "get_ui_state",
            description = "Get a comprehensive structured snapshot of the current user interface, active screen tab, open modal dialogs, send-to-printer status, slicing state, and printer telemetry without needing a screenshot.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val activeArea = context.activeArea
            val activeDialog = context.activeDialog

            val device = context.device
            val prepare = context.prepare
            val preview = context.preview
            val project = context.project

            // Send Dialog details if presented
            val sendConfirmationMap = device?.sendConfirmation?.let { pending ->
                val v = pending.view
                val factsMap = v.facts(false).associate { it.first to it.second }
                val optionsList = v.options.map { opt ->
                    mapOf(
                        "id" to when (opt.id) {
                            ProjectIntents.PrintStartOptionId.BedLeveling -> "bed_leveling"
                            ProjectIntents.PrintStartOptionId.Timelapse -> "timelapse"
                        },
                        "label" to opt.label,
                        "detail" to opt.text,
                        "available" to opt.available,
                        "checked" to opt.checked,
                    )
                }
                mapOf(
                    "title" to v.title,
                    "facts" to factsMap,
                    "blockers" to v.blockers,
                    "warnings" to v.warnings,
                    "start_enabled" to v.startEnabled,
                    "start_refusal" to v.startRefusal,
                    "options" to optionsList,
                    "start_label" to v.startLabel,
                    "upload_label" to v.uploadLabel,
                )
            }

            // Printer summary
            val printerSummary = device?.state?.let { devState ->
                val sum = devState.summary
                val headline = sum?.headline?.let { String(CharArray(it.size) { i -> it[i].toChar() }) }.orEmpty()
                val detail = sum?.detail?.let { String(CharArray(it.size) { i -> it[i].toChar() }) }.orEmpty()
                val facts = sum?.facts?.associate { fact ->
                    val label = String(CharArray(fact.label.size) { i -> fact.label[i].toChar() })
                    val value = String(CharArray(fact.value.size) { i -> fact.value[i].toChar() })
                    label to value
                }.orEmpty()
                mapOf(
                    "connected" to devState.connected,
                    "connecting" to devState.connecting,
                    "headline" to headline,
                    "detail" to detail,
                    "nozzle_temp" to (facts["Nozzle"] ?: ""),
                    "bed_temp" to (facts["Bed"] ?: ""),
                    "elapsed" to (facts["Elapsed"] ?: ""),
                )
            }

            // Slicing state
            val sliceState = prepare?.state?.let { prepState ->
                mapOf(
                    "is_slicing" to (prepState.job != null),
                    "progress_percent" to (prepState.job?.percent ?: if (prepState.result != null) 100.0 else 0.0),
                    "job_message" to (prepState.job?.message ?: if (prepState.result != null) "Slice ready" else "Idle"),
                    "has_result" to (prepState.result != null),
                    "sliced_plate_name" to (prepState.result?.plateName),
                    "file_name" to (prepState.result?.name),
                )
            }

            // Preview state
            val previewState = preview?.state?.let { prev ->
                mapOf(
                    "has_gcode" to (prev.source != null),
                    "source" to prev.source,
                    "loading" to prev.loading,
                    "layer_count" to prev.layerCount,
                    "layer_range" to prev.layerRange?.let { listOf(it.first, it.second) },
                    "totals" to prev.summary?.totals,
                    "tools" to prev.summary?.tools?.map { it.text },
                    "withdrawn" to prev.withdrawn,
                )
            }

            // Project summary
            val projectSummary = project?.let { pm ->
                val p = pm.view
                mapOf(
                    "project_name" to p.name,
                    "dirty" to p.dirty,
                    "plates_total" to p.plates,
                    "active_plate" to p.activePlate?.name,
                    "selection_total" to p.selection.total,
                    "message" to pm.message,
                    "busy" to pm.busy,
                )
            }

            val state = mapOf(
                "active_area" to activeArea,
                "active_dialog" to activeDialog,
                "send_confirmation_dialog" to sendConfirmationMap,
                "send_state" to mapOf(
                    "busy" to (device?.sendState?.busy ?: false),
                    "status" to (device?.sendState?.status ?: ""),
                ),
                "slice_state" to sliceState,
                "preview_state" to previewState,
                "printer_summary" to printerSummary,
                "project_summary" to projectSummary,
            )

            McpToolResult.text(McpJson.stringify(state, indent = 2))
        }

        registry.registerTool(
            name = "get_screen_summary",
            description = "Get a concise natural language summary of what is currently on the screen, active dialogs, printer status, and slicing results without taking a screenshot.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val area = context.activeArea.replaceFirstChar { it.uppercase() }
            val dialog = context.activeDialog
            val device = context.device
            val prepare = context.prepare
            val preview = context.preview
            val project = context.project

            val sb = StringBuilder()
            sb.append("Current Tab: ").append(area).append("\n")

            if (dialog != null) {
                sb.append("Active Dialog: ").append(dialog).append("\n")
                if (dialog == "send_confirmation") {
                    device?.sendConfirmation?.view?.let { v ->
                        sb.append("  • Send Confirmation: \"").append(v.title).append("\"\n")
                        v.facts(false).forEach { (lbl, valStr) ->
                            sb.append("    - ").append(lbl).append(": ").append(valStr).append("\n")
                        }
                        if (v.blockers.isNotEmpty()) {
                            sb.append("    - Blockers: ").append(v.blockers.joinToString("; ")).append("\n")
                        }
                        if (v.warnings.isNotEmpty()) {
                            sb.append("    - Warnings: ").append(v.warnings.joinToString("; ")).append("\n")
                        }
                        sb.append("    - Start Enabled: ").append(v.startEnabled).append("\n")
                        v.options.forEach { opt ->
                            sb.append("    - Option [").append(if (opt.checked) "x" else " ")
                                .append("] ").append(opt.label).append(" (available: ").append(opt.available).append(")\n")
                        }
                    }
                }
            } else {
                sb.append("Active Dialog: None\n")
            }

            // Send State
            device?.sendState?.let { s ->
                val status = s.status
                if (s.busy || !status.isNullOrEmpty()) {
                    sb.append("Send Progress: ").append(if (s.busy) "[BUSY] " else "").append(status ?: "").append("\n")
                }
            }

            // Printer
            val devState = device?.state
            if (devState != null) {
                if (devState.connected) {
                    val sum = devState.summary
                    val headline = sum?.headline?.let { String(CharArray(it.size) { i -> it[i].toChar() }) } ?: "Connected"
                    val facts = sum?.facts?.associate { fact ->
                        val label = String(CharArray(fact.label.size) { i -> fact.label[i].toChar() })
                        val value = String(CharArray(fact.value.size) { i -> fact.value[i].toChar() })
                        label to value
                    }.orEmpty()
                    val nozzle = facts["Nozzle"] ?: "25 °C"
                    val bed = facts["Bed"] ?: "23 °C"
                    sb.append("Printer: Connected (").append(headline).append(", Nozzle: ").append(nozzle).append(", Bed: ").append(bed).append(")\n")
                } else if (devState.connecting) {
                    sb.append("Printer: Connecting...\n")
                } else {
                    sb.append("Printer: Disconnected\n")
                }
            }

            // Slice & Preview
            val prev = preview?.state
            if (prev?.source != null) {
                sb.append("Preview G-code: ").append(prev.source)
                prev.summary?.let { s ->
                    sb.append(" (").append(s.totals).append(")")
                }
                sb.append("\n")
            } else if (prepare?.state?.result != null) {
                val res = prepare.state.result!!
                sb.append("Slice Ready: ").append(res.name).append(" (").append(res.plateName).append(")\n")
            } else if (prepare?.state?.job != null) {
                sb.append("Slicing: ").append(prepare.state.job?.percent?.toInt() ?: 0).append("% - ").append(prepare.state.job?.message ?: "").append("\n")
            }

            // Project
            project?.let { pm ->
                val p = pm.view
                sb.append("Project: \"").append(p.name).append("\" (")
                    .append(p.plates).append(" plate(s), active: \"")
                    .append(p.activePlate?.name ?: "Plate 1").append("\", ")
                    .append(p.selection.total).append(" item(s) selected)")
                if (!pm.message.isNullOrEmpty()) {
                    sb.append(" [Message: ").append(pm.message).append("]")
                }
                sb.append("\n")
            }

            McpToolResult.text(sb.toString().trimEnd())
        }

        registry.registerTool(
            name = "navigate_to",
            description = "Switch the active product tab/area on screen without needing to click coordinates. Options: 'workspace' (3D plate editor), 'prepare' (slice settings), 'preview' (toolpath inspection), 'device' (printers & status), 'project' (file/document catalog).",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "area" to mapOf(
                        "type" to "string",
                        "enum" to listOf("workspace", "prepare", "preview", "device", "project"),
                        "description" to "The target product area/tab to navigate to.",
                    ),
                ),
                "required" to listOf("area"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val target = args["area"] as? String
                ?: return@registerTool McpToolResult.error("Missing required parameter: area")

            val ok = context.navigateTo(target)
            if (ok) {
                McpToolResult.text("Successfully navigated to '$target' area.")
            } else {
                McpToolResult.error("Failed to navigate to '$target'. Supported areas: workspace, prepare, preview, device, project.")
            }
        }

        registry.registerTool(
            name = "dismiss_active_dialog",
            description = "Dismiss whichever modal dialog is currently presented (e.g. McpSettings, SendDialog, Shortcuts, SmartPaint, About).",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val dismissed = context.dismissActiveDialog()
            if (dismissed != null) {
                McpToolResult.text("Successfully dismissed '$dismissed' dialog.")
            } else {
                McpToolResult.text("No modal dialog was currently active.")
            }
        }

        registry.registerTool(
            name = "get_app_logs",
            description = "Retrieve recent in-memory log entries, Moonraker connection events, heartbeat logs, and slicing/send diagnostics without needing ADB logcat.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "filter" to mapOf(
                        "type" to "string",
                        "description" to "Optional case-insensitive substring filter (e.g. 'Moonraker', 'heartbeat', 'OrcaXRSend', 'error', 'fault').",
                    ),
                    "limit" to mapOf(
                        "type" to "integer",
                        "description" to "Maximum number of recent lines to retrieve (default: 50, max: 200).",
                    ),
                ),
                "additionalProperties" to false,
            ),
        ) { args ->
            val filter = args["filter"] as? String
            val limit = (args["limit"] as? Number)?.toInt() ?: 50

            val logs = context.getRecentLogs(filter, limit)
            if (logs.isEmpty()) {
                McpToolResult.text("No matching logs found${if (!filter.isNullOrBlank()) " for filter '$filter'" else ""}.")
            } else {
                McpToolResult.text(logs.joinToString("\n"))
            }
        }

        registry.registerTool(
            name = "get_ui_tree",
            description = "Dump the complete semantic UI accessibility hierarchy of the current Android screen in structured JSON. Enables full headless inspection of layout, headings, cards, text, buttons, and switches without needing a screenshot.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val tree = context.getUiTree()
            McpToolResult.text(McpJson.stringify(tree, indent = 2))
        }

        registry.registerTool(
            name = "get_interactive_elements",
            description = "Get a flattened, structured list of all visible interactive buttons, switches, checkboxes, text fields, and tabs on screen with their text labels, states, roles, and bounds. Avoids needing screenshots to discover clickable controls.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val elements = context.getInteractiveElements()
            val result = mapOf(
                "count" to elements.size,
                "elements" to elements,
            )
            McpToolResult.text(McpJson.stringify(result, indent = 2))
        }

        registry.registerTool(
            name = "click_ui_element",
            description = "Click a UI element on screen by matching its text label or content description (e.g. 'Calibrate the build plate first', 'Save Project', 'Brim', 'Slice', 'Device'). Supports optional 'role' filter ('Button', 'Switch', 'Checkbox', 'Tab', 'TextField').",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "target" to mapOf(
                        "type" to "string",
                        "description" to "The text label or accessibility description of the element to click.",
                    ),
                    "role" to mapOf(
                        "type" to "string",
                        "description" to "Optional role filter ('Button', 'Switch', 'Checkbox', 'Tab', 'TextField').",
                    ),
                ),
                "required" to listOf("target"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val target = args["target"] as? String
                ?: return@registerTool McpToolResult.error("Missing required parameter: target")
            val role = args["role"] as? String

            val success = context.clickElement(target, role)
            if (success) {
                McpToolResult.text("Successfully clicked element matching '$target'${if (role != null) " with role '$role'" else ""}.")
            } else {
                McpToolResult.error("Failed to find or click element matching '$target'${if (role != null) " with role '$role'" else ""}. Use 'get_interactive_elements' to see available controls.")
            }
        }

        registry.registerTool(
            name = "input_ui_text",
            description = "Type text into an editable text field on screen. Specify 'text' to type and optional 'target' field label or placeholder.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "text" to mapOf(
                        "type" to "string",
                        "description" to "The text string to set into the input field.",
                    ),
                    "target" to mapOf(
                        "type" to "string",
                        "description" to "Optional label or description of the target field. If omitted, targets currently focused input.",
                    ),
                ),
                "required" to listOf("text"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val text = args["text"] as? String
                ?: return@registerTool McpToolResult.error("Missing required parameter: text")
            val target = args["target"] as? String

            val success = context.setTextInput(text, target)
            if (success) {
                McpToolResult.text("Successfully set text in ${if (target != null) "'$target'" else "focused field"}.")
            } else {
                McpToolResult.error("Failed to set text in ${if (target != null) "'$target'" else "focused field"}.")
            }
        }
    }
}
