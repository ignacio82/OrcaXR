package dev.orcaxr.nativeapp.mcp.tools

import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.nativeapp.mcp.McpContext
import dev.orcaxr.nativeapp.mcp.McpJson
import dev.orcaxr.nativeapp.mcp.McpToolRegistry
import dev.orcaxr.nativeapp.mcp.McpToolResult

object DeviceTools {
    fun register(registry: McpToolRegistry, context: McpContext) {
        registry.registerTool(
            name = "get_printer_status",
            description = "Get connection and telemetry status of the active Klipper/Moonraker 3D printer, including active print progress, remaining time, finish estimate, temperatures, and printer state.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val device = context.device
                ?: return@registerTool McpToolResult.error("Device / printer manager is not available.")

            val state = device.state
            val summary = state.summary

            val headline = summary?.headline?.let { String(CharArray(it.size) { i -> it[i].toChar() }) }.orEmpty()
            val detail = summary?.detail?.let { String(CharArray(it.size) { i -> it[i].toChar() }) }.orEmpty()
            val progressPercent = (summary?.progress as? ProjectIntents.OptionalFinite.Value)?.let { it.value * 100.0 }
            val facts = summary?.facts?.associate { fact ->
                val label = String(CharArray(fact.label.size) { i -> fact.label[i].toChar() })
                val value = String(CharArray(fact.value.size) { i -> fact.value[i].toChar() })
                label to value
            }.orEmpty()

            val statusMap = mapOf(
                "connected" to state.connected,
                "connecting" to state.connecting,
                "connection_message" to state.connection,
                "active_printer_id" to state.activeId,
                "printers_count" to state.printers.size,
                "headline" to headline,
                "detail" to detail,
                "progress_percent" to progressPercent,
                "facts" to facts,
                "present" to (summary?.present ?: false),
                "stale" to (summary?.stale ?: false),
                "tone" to (summary?.tone?.name ?: "disconnected"),
            )

            McpToolResult.text(McpJson.stringify(statusMap, indent = 2))
        }

        registry.registerTool(
            name = "list_printers",
            description = "List all configured Klipper/Moonraker printers and their connection addresses, as well as the active printer selection.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val device = context.device
                ?: return@registerTool McpToolResult.error("Device manager is not available.")

            val printersList = device.state.printers.map { p ->
                mapOf(
                    "id" to p.id,
                    "name" to p.name,
                    "address" to p.address,
                    "is_active" to (p.id == device.state.activeId),
                )
            }

            val result = mapOf(
                "active_id" to device.state.activeId,
                "connected" to device.state.connected,
                "connecting" to device.state.connecting,
                "printers" to printersList,
            )

            McpToolResult.text(McpJson.stringify(result, indent = 2))
        }

        registry.registerTool(
            name = "connect_printer",
            description = "Connect to a Klipper/Moonraker printer. Optionally specify 'printer_name' or 'printer_id' to activate before connecting.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "printer_name" to mapOf(
                        "type" to "string",
                        "description" to "Name of the printer to select and connect to (e.g. 'lava').",
                    ),
                    "printer_id" to mapOf(
                        "type" to "string",
                        "description" to "UUID ID of the printer to select and connect to.",
                    ),
                ),
                "additionalProperties" to false,
            ),
        ) { args ->
            val device = context.device
                ?: return@registerTool McpToolResult.error("Device manager is not available.")

            val targetName = args["printer_name"] as? String
            val targetId = args["printer_id"] as? String

            if (targetId != null) {
                device.activate(targetId)
            } else if (targetName != null) {
                val match = device.state.printers.firstOrNull { it.name.equals(targetName, ignoreCase = true) }
                    ?: return@registerTool McpToolResult.error("No configured printer found with name '$targetName'. Available: ${device.state.printers.map { it.name }}")
                device.activate(match.id)
            }

            device.connect()
            McpToolResult.text("Initiated connection to printer. Use 'get_printer_status' to monitor connection state.")
        }

        registry.registerTool(
            name = "disconnect_printer",
            description = "Disconnect from the currently active Klipper/Moonraker printer.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val device = context.device
                ?: return@registerTool McpToolResult.error("Device manager is not available.")

            device.disconnect()
            McpToolResult.text("Disconnected from printer.")
        }

        registry.registerTool(
            name = "send_to_printer",
            description = "Upload the current sliced plate G-code to the connected Moonraker printer. Prompts the confirmation flow.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val device = context.device
                ?: return@registerTool McpToolResult.error("Device manager is not available.")
            val prepare = context.prepare
                ?: return@registerTool McpToolResult.error("Prepare model is not available.")

            if (!device.state.connected) {
                return@registerTool McpToolResult.error("No printer is currently connected.")
            }

            val sendable = prepare.sendable()
            if (sendable == null) {
                return@registerTool McpToolResult.error("No valid slice available to send. Please slice the active plate first.")
            }

            context.runOnMain {
                device.send(sendable)
            }
            McpToolResult.text("Initiated send of sliced plate '${sendable.filename}' to printer. Use 'get_send_dialog' to inspect confirmation options or 'get_send_status' to monitor progress.")
        }

        registry.registerTool(
            name = "get_send_dialog",
            description = "Get detailed information about the currently open 'Send to printer' confirmation dialog, including printer state, file details, blockers, warnings, and configurable start options (e.g. bed leveling calibration, timelapse) without taking a screenshot.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val device = context.device
                ?: return@registerTool McpToolResult.error("Device manager is not available.")

            val pending = device.sendConfirmation
            if (pending == null) {
                val status = mapOf(
                    "is_showing" to false,
                    "send_busy" to device.sendState.busy,
                    "send_status" to device.sendState.status,
                )
                return@registerTool McpToolResult.text(McpJson.stringify(status, indent = 2))
            }

            val view = pending.view
            val optionsList = view.options.map { opt ->
                mapOf(
                    "id" to when (opt.id) {
                        ProjectIntents.PrintStartOptionId.BedLeveling -> "bed_leveling"
                        ProjectIntents.PrintStartOptionId.Timelapse -> "timelapse"
                    },
                    "label" to opt.label,
                    "detail" to opt.text,
                    "available" to opt.available,
                    "default_checked" to opt.checked,
                )
            }

            val factsMap = view.facts(overwrite = false).associate { it.first to it.second }

            val result = mapOf(
                "is_showing" to true,
                "title" to view.title,
                "facts" to factsMap,
                "blockers" to view.blockers,
                "warnings" to view.warnings,
                "start_enabled" to view.startEnabled,
                "start_refusal" to view.startRefusal,
                "start_options" to optionsList,
                "overwrite_allowed" to view.overwriteAllowed,
                "overwrite_label" to view.overwriteLabel,
                "start_label" to view.startLabel,
                "upload_label" to view.uploadLabel,
                "send_busy" to device.sendState.busy,
                "send_status" to device.sendState.status,
            )

            McpToolResult.text(McpJson.stringify(result, indent = 2))
        }

        registry.registerTool(
            name = "answer_send_dialog",
            description = "Confirm or cancel the 'Send to printer' confirmation dialog. Allows choosing between Upload & Print, Upload only, or Cancel, and toggling start options such as bed leveling calibration.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "choice" to mapOf(
                        "type" to "string",
                        "enum" to listOf("upload_and_print", "upload", "cancel"),
                        "description" to "The decision choice to make.",
                    ),
                    "enable_bed_leveling" to mapOf(
                        "type" to "boolean",
                        "description" to "Whether to enable bed leveling calibration before printing (default false, as printer PRINT_START handles homing and leveling).",
                    ),
                    "enable_timelapse" to mapOf(
                        "type" to "boolean",
                        "description" to "Whether to enable timelapse recording (default false).",
                    ),
                    "overwrite" to mapOf(
                        "type" to "boolean",
                        "description" to "Whether to overwrite existing file if the name collides (default false).",
                    ),
                ),
                "required" to listOf("choice"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val device = context.device
                ?: return@registerTool McpToolResult.error("Device manager is not available.")

            val pending = device.sendConfirmation
                ?: return@registerTool McpToolResult.error("No send confirmation dialog is currently waiting for input.")

            val choiceStr = args["choice"] as? String ?: "cancel"
            val choice = when (choiceStr) {
                "upload_and_print" -> ProjectIntents.PrintWorkflowDecisionChoice.UploadAndPrint
                "upload" -> ProjectIntents.PrintWorkflowDecisionChoice.Upload
                else -> ProjectIntents.PrintWorkflowDecisionChoice.Cancel
            }

            val view = pending.view
            val chosenSet = mutableSetOf<ProjectIntents.PrintStartOptionId>()
            val enableBedLeveling = args["enable_bed_leveling"] as? Boolean
                ?: view.options.firstOrNull { it.id == ProjectIntents.PrintStartOptionId.BedLeveling }?.checked ?: false
            val enableTimelapse = args["enable_timelapse"] as? Boolean
                ?: view.options.firstOrNull { it.id == ProjectIntents.PrintStartOptionId.Timelapse }?.checked ?: false

            if (enableBedLeveling) chosenSet.add(ProjectIntents.PrintStartOptionId.BedLeveling)
            if (enableTimelapse) chosenSet.add(ProjectIntents.PrintStartOptionId.Timelapse)

            val overwrite = (args["overwrite"] as? Boolean) ?: false
            val decision = view.decide(choice, overwrite = overwrite, chosen = chosenSet)

            context.runOnMain {
                device.answerSend(decision)
            }

            McpToolResult.text("Successfully answered send dialog with choice '$choiceStr' (bed_leveling=$enableBedLeveling, timelapse=$enableTimelapse, overwrite=$overwrite).")
        }

        registry.registerTool(
            name = "get_send_status",
            description = "Get current status of sending a sliced model to the printer (idle, busy, uploading progress, preparing, completed, or failed message).",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val device = context.device
                ?: return@registerTool McpToolResult.error("Device manager is not available.")

            val status = mapOf(
                "busy" to device.sendState.busy,
                "status" to device.sendState.status,
                "is_confirmation_showing" to (device.sendConfirmation != null),
                "connected" to device.state.connected,
                "connecting" to device.state.connecting,
            )

            McpToolResult.text(McpJson.stringify(status, indent = 2))
        }

        registry.registerTool(
            name = "control_printer",
            description = "Send operational command to the connected printer (pause, resume, cancel, emergency_stop).",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "command" to mapOf(
                        "type" to "string",
                        "enum" to listOf("pause", "resume", "cancel", "emergency_stop"),
                        "description" to "The command to dispatch to the printer.",
                    ),
                ),
                "required" to listOf("command"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val command = args["command"] as? String
                ?: return@registerTool McpToolResult.error("Missing required parameter: command")

            val device = context.device
                ?: return@registerTool McpToolResult.error("Device manager is not available.")

            if (!device.state.connected) {
                return@registerTool McpToolResult.error("No printer is currently connected.")
            }

            val cmd = when (command) {
                "pause" -> ProjectIntents.PrintJobCommand.Pause
                "resume" -> ProjectIntents.PrintJobCommand.Resume
                "cancel" -> ProjectIntents.PrintJobCommand.Cancel
                "emergency_stop" -> ProjectIntents.PrintJobCommand.EmergencyStop
                else -> return@registerTool McpToolResult.error("Unsupported command: $command")
            }

            context.runOnMain {
                device.command(cmd)
            }

            McpToolResult.text("Dispatched command '$command' to printer.")
        }

        registry.registerTool(
            name = "get_device_diagnostics",
            description = "Get comprehensive low-level printer diagnostics, including Moonraker WebSocket status, connection configuration, send state, pending dialog facts/blockers, and recent device logs without screenshots.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val device = context.device
                ?: return@registerTool McpToolResult.error("Device manager is not available.")

            val state = device.state
            val sendState = device.sendState
            val pending = device.sendConfirmation

            val confirmationMap = pending?.let {
                val v = it.view
                mapOf(
                    "title" to v.title,
                    "facts" to v.facts(false).associate { f -> f.first to f.second },
                    "blockers" to v.blockers,
                    "warnings" to v.warnings,
                    "start_enabled" to v.startEnabled,
                    "start_refusal" to v.startRefusal,
                    "options" to v.options.map { opt ->
                        mapOf(
                            "id" to when (opt.id) {
                                ProjectIntents.PrintStartOptionId.BedLeveling -> "bed_leveling"
                                ProjectIntents.PrintStartOptionId.Timelapse -> "timelapse"
                            },
                            "label" to opt.label,
                            "checked" to opt.checked,
                            "available" to opt.available,
                            "text" to opt.text,
                        )
                    },
                )
            }

            val recentDeviceLogs = context.getRecentLogs("OrcaXR", limit = 30)

            val diag = mapOf(
                "connected" to state.connected,
                "connecting" to state.connecting,
                "active_id" to state.activeId,
                "connection_message" to state.connection,
                "send" to mapOf(
                    "busy" to sendState.busy,
                    "status" to sendState.status,
                ),
                "send_confirmation" to confirmationMap,
                "recent_logs" to recentDeviceLogs,
            )

            McpToolResult.text(McpJson.stringify(diag, indent = 2))
        }
    }
}
