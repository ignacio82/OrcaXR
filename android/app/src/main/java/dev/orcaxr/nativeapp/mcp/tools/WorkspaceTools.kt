package dev.orcaxr.nativeapp.mcp.tools

import dev.orcaxr.core.ProjectIntents
import dev.orcaxr.core.ProjectRowSelection
import dev.orcaxr.nativeapp.ai.ColorNames
import dev.orcaxr.nativeapp.mcp.McpContext
import dev.orcaxr.nativeapp.mcp.McpJson
import dev.orcaxr.nativeapp.mcp.McpToolRegistry
import dev.orcaxr.nativeapp.mcp.McpToolResult

object WorkspaceTools {
    fun register(registry: McpToolRegistry, context: McpContext) {
        registry.registerTool(
            name = "get_workspace_state",
            description = "Get an automation snapshot of the open 3D workspace, plates, selection, bed bounds, and loaded filaments.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val project = context.project
            if (project == null) {
                return@registerTool McpToolResult.error("Project workspace is not available.")
            }

            val view = project.view
            val selection = view.selection

            val activePlateMap = view.activePlate?.let {
                mapOf(
                    "id" to it.id,
                    "name" to it.name,
                    "printable" to it.printable,
                    "objects_count" to it.objects,
                )
            }

            val platesList = view.plateList.map {
                mapOf(
                    "id" to it.id,
                    "name" to it.name,
                    "printable" to it.printable,
                    "objects_count" to it.objects,
                    "is_active" to (it.id == view.activePlate?.id),
                )
            }

            val physicalFilaments = view.filaments.options.filter { !it.mixed }
            val filamentsList = physicalFilaments.mapIndexed { index, opt ->
                mapOf(
                    "slot" to index + 1,
                    "id" to opt.id,
                    "name" to opt.name,
                    "color" to opt.color,
                    "color_name" to ColorNames.nameOf(opt.color),
                    "material" to (opt.material ?: ""),
                    "tool_id" to (opt.toolId ?: index),
                    "enabled" to opt.enabled,
                )
            }

            val state = mapOf(
                "ready" to view.ready,
                "project_name" to view.name,
                "dirty" to view.dirty,
                "plates_total" to view.plates,
                "active_plate" to activePlateMap,
                "plates" to platesList,
                "selection" to mapOf(
                    "total" to selection.total,
                    "instances" to selection.instances.toList(),
                    "has_instance" to selection.hasInstance,
                ),
                "filaments" to filamentsList,
                "bed" to mapOf(
                    "width_mm" to view.bed.widthMm,
                    "depth_mm" to view.bed.depthMm,
                    "height_mm" to (view.bed.printableHeightMm ?: 0.0),
                ),
                "undo" to view.undo,
                "redo" to view.redo,
            )

            McpToolResult.text(McpJson.stringify(state, indent = 2))
        }

        registry.registerTool(
            name = "get_project_tree",
            description = "Get the hierarchical tree of objects, parts, modifiers, and filaments on the build plate.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")

            val rows = project.view.rows.map { row ->
                val keyStr = String(CharArray(row.key.size) { row.key[it].toChar() })
                val labelStr = String(CharArray(row.label.size) { row.label[it].toChar() })
                val filamentInfo = (row.indicators.filament as? ProjectIntents.OptionalObjectTreeFilament.Value)?.value?.let { fil ->
                    val colorStr = String(CharArray(fil.color.size) { fil.color[it].toChar() })
                    mapOf(
                        "id" to String(CharArray(fil.id.size) { fil.id[it].toChar() }),
                        "name" to String(CharArray(fil.name.size) { fil.name[it].toChar() }),
                        "color" to colorStr,
                        "color_name" to ColorNames.nameOf(colorStr),
                        "mixed" to fil.mixed,
                        "inherited" to fil.inherited,
                    )
                }
                mapOf(
                    "key" to keyStr,
                    "label" to labelStr,
                    "kind" to row.kind.name,
                    "level" to row.level,
                    "is_selected" to row.selected,
                    "filament" to filamentInfo,
                )
            }

            val result = mapOf(
                "total_rows" to project.view.totalRows,
                "rows" to rows,
            )
            McpToolResult.text(McpJson.stringify(result, indent = 2))
        }

        registry.registerTool(
            name = "select_row",
            description = "Select a specific row or object/part in the Objects tree by its key (from get_project_tree).",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "key" to mapOf(
                        "type" to "string",
                        "description" to "The row key to select (e.g. 'object:1' or 'volume:1:1').",
                    ),
                    "mode" to mapOf(
                        "type" to "string",
                        "enum" to listOf("replace", "toggle", "range"),
                        "description" to "Selection mode: 'replace' (default), 'toggle', or 'range'.",
                    ),
                ),
                "required" to listOf("key"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val key = args["key"] as? String
                ?: return@registerTool McpToolResult.error("Missing required parameter: key")
            val modeStr = (args["mode"] as? String) ?: "replace"
            val mode = when (modeStr) {
                "toggle" -> ProjectRowSelection.Toggle
                "range" -> ProjectRowSelection.Range
                else -> ProjectRowSelection.Replace
            }
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")

            try {
                project.workspace.selectRow(key, mode).get()
                McpToolResult.text("Selected row '$key' with mode '$modeStr'")
            } catch (t: Throwable) {
                McpToolResult.error("Failed to select row '$key': ${t.message}")
            }
        }

        registry.registerTool(
            name = "set_gizmo_tool",
            description = "Switch the active 3D manipulation gizmo tool. Options: move, rotate, scale, paint, lay_on_face, measure.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "tool" to mapOf(
                        "type" to "string",
                        "enum" to listOf("move", "rotate", "scale", "paint", "lay_on_face", "measure"),
                        "description" to "The gizmo tool mode to activate.",
                    ),
                ),
                "required" to listOf("tool"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val tool = args["tool"] as? String
                ?: return@registerTool McpToolResult.error("Missing required parameter: tool")

            val actionId = when (tool) {
                "move" -> "tool_move"
                "rotate" -> "tool_rotate"
                "scale" -> "tool_scale"
                "paint" -> "tool_paint"
                "lay_on_face" -> "tool_lay_on_face"
                "measure" -> "tool_measure"
                else -> return@registerTool McpToolResult.error("Invalid tool mode: $tool")
            }

            val success = context.runAction(actionId)
            if (success) {
                McpToolResult.text("Gizmo tool set to '$tool' (action: $actionId)")
            } else {
                McpToolResult.error("Failed to set gizmo tool to '$tool'")
            }
        }

        registry.registerTool(
            name = "assign_filament",
            description = "Assign physical extruder filament slot (1-indexed number) to the selected model(s) or part(s).",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "slot" to mapOf(
                        "type" to "integer",
                        "description" to "Filament toolhead slot (e.g. 1, 2, 3, 4).",
                    ),
                ),
                "required" to listOf("slot"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val slotNum = (args["slot"] as? Number)?.toInt()
                ?: return@registerTool McpToolResult.error("Parameter 'slot' must be an integer.")

            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")

            val physical = project.view.filaments.options.filter { !it.mixed }
            if (slotNum !in 1..physical.size) {
                return@registerTool McpToolResult.error("Slot $slotNum is out of range (available physical slots: 1 to ${physical.size})")
            }
            val option = physical[slotNum - 1]

            val assignedCount = try {
                project.workspace.assignFilament(option.id).get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to assign filament: ${t.message}")
            }

            if (assignedCount == null || assignedCount == 0) {
                McpToolResult.error("No scopes in current selection could take a filament assignment.")
            } else {
                McpToolResult.text("Successfully assigned slot $slotNum ('${option.name}') to $assignedCount scope(s).")
            }
        }

        registry.registerTool(
            name = "remap_filaments",
            description = "Remap or swap filament slots on the model(s) / build plate. 'mapping' maps source slot numbers (1-indexed) to target slot numbers.\n" +
                "Examples:\n" +
                "- Replace one color: {\"3\": 1} remaps all model parts and painted facets using Slot 3 to Slot 1.\n" +
                "- Swap two colors: {\"3\": 1, \"1\": 3} swaps Slot 3 and Slot 1 assignments on the model.\n" +
                "IMPORTANT: ONLY include the slots being changed in 'mapping'. Do NOT include unchanged slots.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "mapping" to mapOf(
                        "type" to "object",
                        "description" to "Map of source slot number (1-indexed) to target slot number, e.g. {\"3\": 1} to replace slot 3 with slot 1, or {\"3\": 1, \"1\": 3} to swap slot 3 and 1. Do NOT include unchanged slots.",
                    ),
                    "scope" to mapOf(
                        "type" to "string",
                        "enum" to listOf("model"),
                        "description" to "Target of remapping. Default is 'model' (for model bodies, parts, and painted facets).",
                    ),
                ),
                "required" to listOf("mapping"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")

            val mappingArg = args["mapping"] as? Map<*, *>
                ?: return@registerTool McpToolResult.error("Parameter 'mapping' must be an object of slot mappings, e.g. {\"3\": 1}")

            val scope = (args["scope"] as? String) ?: "model"
            val physical = project.view.filaments.options.filter { !it.mixed }

            if (scope == "palette") {
                val oldSlots = project.view.filamentSlots.palette
                val edits = mutableListOf<String>()
                for ((src, dst) in mappingArg) {
                    val srcSlot = src.toString().toIntOrNull()
                    val dstSlot = (dst as? Number)?.toInt() ?: dst.toString().toIntOrNull()
                    if (srcSlot == null || dstSlot == null || srcSlot !in 1..oldSlots.size || dstSlot !in 1..oldSlots.size) {
                        return@registerTool McpToolResult.error("Invalid slot number in mapping: $src -> $dst. Must be between 1 and ${oldSlots.size}.")
                    }
                    if (srcSlot == dstSlot) continue
                    val srcColor = oldSlots[srcSlot - 1].color
                    context.runOnMain {
                        project.recolorFilament(dstSlot - 1, srcColor)
                    }
                    edits.add("Slot $dstSlot recolored to Slot $srcSlot color ($srcColor)")
                }
                return@registerTool McpToolResult.text("Palette colors updated:\n" + edits.joinToString("\n"))
            }

            val filamentIdMapping = mutableMapOf<String, String>()
            val humanLog = mutableListOf<String>()

            for ((src, dst) in mappingArg) {
                val srcSlot = src.toString().toIntOrNull()
                val dstSlot = (dst as? Number)?.toInt() ?: dst.toString().toIntOrNull()
                if (srcSlot == null || dstSlot == null) {
                    return@registerTool McpToolResult.error("Slot numbers must be integers (got '$src' -> '$dst')")
                }
                if (srcSlot == dstSlot) continue
                if (srcSlot !in 1..physical.size || dstSlot !in 1..physical.size) {
                    return@registerTool McpToolResult.error("Slot out of range: $srcSlot -> $dstSlot. Available slots: 1..${physical.size}")
                }
                val srcOpt = physical[srcSlot - 1]
                val dstOpt = physical[dstSlot - 1]
                filamentIdMapping[srcOpt.id] = dstOpt.id
                humanLog.add("Slot $srcSlot ('${srcOpt.name}') -> Slot $dstSlot ('${dstOpt.name}')")
            }

            if (filamentIdMapping.isEmpty()) {
                return@registerTool McpToolResult.text("No filament changes specified (source and target slots are identical).")
            }

            val count = try {
                project.workspace.remapFilaments(filamentIdMapping).get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to remap filaments: ${t.message}")
            }

            if (count == null || count == 0) {
                McpToolResult.text("Remap completed: 0 scopes on the active plate/selection were using the specified source filaments.")
            } else {
                McpToolResult.text("Successfully remapped filaments across $count scope(s) in a single atomic step:\n" + humanLog.joinToString("\n"))
            }
        }

        registry.registerTool(
            name = "scale_model",
            description = "Resize or scale 3D model(s) on the build plate by percentage (e.g. 150 for 150%), multiplier factor (e.g. 2.0 to double, 0.5 to halve), or fit to build volume, or reset to 100%.\n" +
                "Examples:\n" +
                "- Resize to 150%: {\"percent\": 150}\n" +
                "- Double size (2x): {\"factor\": 2.0}\n" +
                "- Halve size (0.5x): {\"factor\": 0.5}\n" +
                "- Scale to fit print bed: {\"action\": \"fit_volume\"}\n" +
                "- Reset scale to 100%: {\"action\": \"reset\"}",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "percent" to mapOf(
                        "type" to "number",
                        "description" to "Uniform target scale percentage (e.g. 150 for 150%, 50 for 50%, 200 for 200%).",
                    ),
                    "factor" to mapOf(
                        "type" to "number",
                        "description" to "Relative multiplier factor (e.g. 2.0 to double size, 0.5 for half size, 1.25 for 25% larger).",
                    ),
                    "action" to mapOf(
                        "type" to "string",
                        "enum" to listOf("set", "fit_volume", "reset"),
                        "description" to "Scaling action: 'set' (default), 'fit_volume' (scale to fit print volume), or 'reset' (reset scale to 100%).",
                    ),
                    "scale_x" to mapOf("type" to "number", "description" to "Scale X percentage."),
                    "scale_y" to mapOf("type" to "number", "description" to "Scale Y percentage."),
                    "scale_z" to mapOf("type" to "number", "description" to "Scale Z percentage."),
                ),
                "additionalProperties" to false,
            ),
        ) { args ->
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")

            val action = (args["action"] as? String)?.lowercase() ?: "set"
            ensureModelSelected(project)

            if (action == "fit_volume") {
                val changed = try {
                    project.workspace.scaleSelectedToFit().get()
                } catch (t: Throwable) {
                    return@registerTool McpToolResult.error("Failed to scale model to fit volume: ${t.message}")
                }
                return@registerTool if (changed == 0) {
                    McpToolResult.text("The model already fills the printable build volume.")
                } else {
                    McpToolResult.text("Scaled model to fit the printable build volume.")
                }
            }

            if (action == "reset") {
                try {
                    project.workspace.resetSelected(dev.orcaxr.core.TransformReset.SCALE).get()
                } catch (t: Throwable) {
                    return@registerTool McpToolResult.error("Failed to reset scale: ${t.message}")
                }
                return@registerTool McpToolResult.text("Reset model scale to 100 percent.")
            }

            // Read current scale percentages
            val currentScales = project.view.inspector?.fields(dev.orcaxr.core.TransformTool.SCALE)?.values
                ?: listOf(100.0, 100.0, 100.0)
            val currentUniform = currentScales.firstOrNull() ?: 100.0

            val rawPercent = (args["percent"] as? Number)?.toDouble()
            val rawFactor = (args["factor"] as? Number)?.toDouble()
            val rawX = (args["scale_x"] as? Number)?.toDouble()
            val rawY = (args["scale_y"] as? Number)?.toDouble()
            val rawZ = (args["scale_z"] as? Number)?.toDouble()

            val targetX: Double
            val targetY: Double
            val targetZ: Double

            when {
                rawFactor != null -> {
                    targetX = (currentScales.getOrElse(0) { currentUniform }) * rawFactor
                    targetY = (currentScales.getOrElse(1) { currentUniform }) * rawFactor
                    targetZ = (currentScales.getOrElse(2) { currentUniform }) * rawFactor
                }
                rawPercent != null -> {
                    targetX = rawPercent
                    targetY = rawPercent
                    targetZ = rawPercent
                }
                rawX != null || rawY != null || rawZ != null -> {
                    targetX = rawX ?: currentScales.getOrElse(0) { currentUniform }
                    targetY = rawY ?: currentScales.getOrElse(1) { currentUniform }
                    targetZ = rawZ ?: currentScales.getOrElse(2) { currentUniform }
                }
                else -> {
                    return@registerTool McpToolResult.error("Specify 'percent', 'factor', or action ('fit_volume', 'reset') to scale the model.")
                }
            }

            if (targetX <= 0.0 || targetY <= 0.0 || targetZ <= 0.0) {
                return@registerTool McpToolResult.error("Scale percentage must be greater than zero.")
            }

            val texts = listOf(
                "%.2f".format(java.util.Locale.US, targetX),
                "%.2f".format(java.util.Locale.US, targetY),
                "%.2f".format(java.util.Locale.US, targetZ),
            )

            try {
                project.workspace.editTransform(dev.orcaxr.core.TransformTool.SCALE, texts).get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to scale model: ${t.message}")
            }

            val displayPercent = if (targetX == targetY && targetY == targetZ) {
                if (targetX % 1.0 == 0.0) "${targetX.toInt()}" else "%.1f".format(java.util.Locale.US, targetX)
            } else {
                "X ${targetX.toInt()} percent, Y ${targetY.toInt()} percent, Z ${targetZ.toInt()}"
            }

            McpToolResult.text("Resized model to $displayPercent percent.")
        }

        registry.registerTool(
            name = "transform_model",
            description = "Move, center, rotate, or drop the 3D model(s) on the build plate.\n" +
                "Examples:\n" +
                "- Center on bed: {\"operation\": \"center\"}\n" +
                "- Drop to bed: {\"operation\": \"drop_to_bed\"}\n" +
                "- Rotate 90 degrees around Z: {\"operation\": \"rotate\", \"z_deg\": 90}\n" +
                "- Reset rotation: {\"operation\": \"reset_rotation\"}\n" +
                "- Move to coordinates: {\"operation\": \"move\", \"x_mm\": 100, \"y_mm\": 100}",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "operation" to mapOf(
                        "type" to "string",
                        "enum" to listOf("center", "drop_to_bed", "rotate", "reset_rotation", "move"),
                        "description" to "The transform operation to perform.",
                    ),
                    "x_mm" to mapOf("type" to "number", "description" to "X translation in millimeters."),
                    "y_mm" to mapOf("type" to "number", "description" to "Y translation in millimeters."),
                    "z_mm" to mapOf("type" to "number", "description" to "Z translation in millimeters."),
                    "x_deg" to mapOf("type" to "number", "description" to "X rotation in degrees."),
                    "y_deg" to mapOf("type" to "number", "description" to "Y rotation in degrees."),
                    "z_deg" to mapOf("type" to "number", "description" to "Z rotation in degrees."),
                ),
                "required" to listOf("operation"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")

            val op = (args["operation"] as? String)?.lowercase()
                ?: return@registerTool McpToolResult.error("Missing required parameter: operation")

            ensureModelSelected(project)

            when (op) {
                "center" -> {
                    try {
                        project.workspace.centerSelectedOnPlate().get()
                        McpToolResult.text("Centered model on the build plate.")
                    } catch (t: Throwable) {
                        McpToolResult.error("Failed to center model: ${t.message}")
                    }
                }
                "drop_to_bed" -> {
                    try {
                        project.workspace.dropSelectedToBed().get()
                        McpToolResult.text("Dropped model onto the print bed.")
                    } catch (t: Throwable) {
                        McpToolResult.error("Failed to drop model to bed: ${t.message}")
                    }
                }
                "reset_rotation" -> {
                    try {
                        project.workspace.resetSelected(dev.orcaxr.core.TransformReset.ROTATION).get()
                        McpToolResult.text("Reset model rotation.")
                    } catch (t: Throwable) {
                        McpToolResult.error("Failed to reset rotation: ${t.message}")
                    }
                }
                "rotate" -> {
                    val currentRot = project.view.inspector?.fields(dev.orcaxr.core.TransformTool.ROTATE)?.values
                        ?: listOf(0.0, 0.0, 0.0)
                    val rx = (args["x_deg"] as? Number)?.toDouble() ?: currentRot.getOrElse(0) { 0.0 }
                    val ry = (args["y_deg"] as? Number)?.toDouble() ?: currentRot.getOrElse(1) { 0.0 }
                    val rz = (args["z_deg"] as? Number)?.toDouble() ?: currentRot.getOrElse(2) { 0.0 }
                    val texts = listOf(
                        "%.2f".format(java.util.Locale.US, rx),
                        "%.2f".format(java.util.Locale.US, ry),
                        "%.2f".format(java.util.Locale.US, rz),
                    )
                    try {
                        project.workspace.editTransform(dev.orcaxr.core.TransformTool.ROTATE, texts).get()
                        McpToolResult.text("Rotated model.")
                    } catch (t: Throwable) {
                        McpToolResult.error("Failed to rotate model: ${t.message}")
                    }
                }
                "move" -> {
                    val currentPos = project.view.inspector?.fields(dev.orcaxr.core.TransformTool.MOVE)?.values
                        ?: listOf(0.0, 0.0, 0.0)
                    val mx = (args["x_mm"] as? Number)?.toDouble() ?: currentPos.getOrElse(0) { 0.0 }
                    val my = (args["y_mm"] as? Number)?.toDouble() ?: currentPos.getOrElse(1) { 0.0 }
                    val mz = (args["z_mm"] as? Number)?.toDouble() ?: currentPos.getOrElse(2) { 0.0 }
                    val texts = listOf(
                        "%.2f".format(java.util.Locale.US, mx),
                        "%.2f".format(java.util.Locale.US, my),
                        "%.2f".format(java.util.Locale.US, mz),
                    )
                    try {
                        project.workspace.editTransform(dev.orcaxr.core.TransformTool.MOVE, texts).get()
                        McpToolResult.text("Moved model to specified position.")
                    } catch (t: Throwable) {
                        McpToolResult.error("Failed to move model: ${t.message}")
                    }
                }
                else -> McpToolResult.error("Unknown operation: $op. Valid operations: center, drop_to_bed, rotate, reset_rotation, move.")
            }
        }

        registry.registerTool(
            name = "duplicate_model",
            description = "Duplicate the selected 3D model on the build plate. Accepts optional 'count' (number of copies to make, default 1).\n" +
                "Examples:\n" +
                "- Duplicate model: {\"count\": 1}\n" +
                "- Make 3 copies: {\"count\": 3}",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "count" to mapOf(
                        "type" to "integer",
                        "description" to "Number of duplicates to create (default: 1, max: 20).",
                    ),
                ),
                "additionalProperties" to false,
            ),
        ) { args ->
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")
            ensureModelSelected(project)

            val count = (args["count"] as? Number)?.toInt()?.coerceIn(1, 20) ?: 1
            var successful = 0
            for (i in 0 until count) {
                val ok = context.runAction("edit_duplicate")
                if (ok) {
                    successful++
                    Thread.sleep(80)
                } else break
            }

            if (successful > 0) {
                val msg = if (successful == 1) "Created 1 duplicate of the model." else "Created $successful duplicates of the model."
                McpToolResult.text(msg)
            } else {
                McpToolResult.error("Could not duplicate model.")
            }
        }

        registry.registerTool(
            name = "delete_model",
            description = "Delete the currently selected model or object from the build plate.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")
            ensureModelSelected(project)

            val ok = context.runAction("edit_delete_selected")
            if (ok) {
                McpToolResult.text("Deleted model from the build plate.")
            } else {
                McpToolResult.error("Could not delete model.")
            }
        }

        registry.registerTool(
            name = "arrange_bed",
            description = "Automatically arrange and pack all models neatly across the active build plate.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")

            val ok = context.runAction("arrange_all")
            if (ok) {
                McpToolResult.text("Arranged all models on the build plate.")
            } else {
                McpToolResult.error("Could not arrange models on the plate.")
            }
        }

        registry.registerTool(
            name = "sync_filaments",
            description = "Add or replace physical filament slots in the project by color hex codes or named colors. " +
                "Use this to ensure the project has specific filament colors before painting. " +
                "Example: {\"slots\": [{\"color\": \"#FFFFFF\", \"material\": \"PLA\"}, {\"color\": \"blue\"}]}",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "slots" to mapOf(
                        "type" to "array",
                        "items" to mapOf(
                            "type" to "object",
                            "properties" to mapOf(
                                "color" to mapOf(
                                    "type" to "string",
                                    "description" to "Hex color (e.g. '#FFFFFF') or color name (e.g. 'white', 'blue').",
                                ),
                                "material" to mapOf(
                                    "type" to "string",
                                    "description" to "Material type (default: 'PLA').",
                                ),
                            ),
                            "required" to listOf("color"),
                        ),
                        "description" to "List of filament slots to sync into the project.",
                    ),
                ),
                "required" to listOf("slots"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")

            @Suppress("UNCHECKED_CAST")
            val slotsArg = args["slots"] as? List<Map<*, *>>
                ?: return@registerTool McpToolResult.error("Parameter 'slots' must be an array of objects.")

            if (slotsArg.isEmpty()) {
                return@registerTool McpToolResult.error("At least one slot is required.")
            }

            val physical = project.view.filaments.options.filter { !it.mixed }
            val nextToolId = (physical.maxOfOrNull { it.toolId ?: 0 } ?: (physical.size - 1)) + 1

            val printerSlots = slotsArg.mapIndexed { i, slot ->
                val rawColor = slot["color"]?.toString()?.trim()
                    ?: return@registerTool McpToolResult.error("Each slot needs a 'color' field.")
                val hex = if (rawColor.startsWith("#")) rawColor else (ColorNames.hexForColorName(rawColor)
                    ?: return@registerTool McpToolResult.error("Unknown color name: '$rawColor'. Use hex format (e.g. '#FF0000') or known names (white, blue, red, etc.)"))
                if (ColorNames.parseRgb(hex) == null) {
                    return@registerTool McpToolResult.error("Invalid hex color: '$hex'")
                }
                val material = slot["material"]?.toString()?.trim()?.takeIf { it.isNotBlank() } ?: "PLA"
                ProjectIntents.PrinterSlot(
                    toolId = (nextToolId + i).toLong(),
                    color = hex.map { it.code },
                    material = material.map { it.code },
                    subType = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
                    vendor = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
                )
            }

            val newIds = List(printerSlots.size) { java.util.UUID.randomUUID().toString() }
            try {
                project.workspace.syncPhysicalFilaments(printerSlots, newIds).get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to sync filaments: ${t.message}")
            }

            val refreshed = project.view.filaments.options.filter { !it.mixed }
            val summary = refreshed.mapIndexed { idx, fil ->
                "Slot ${idx + 1}: ${fil.color} (${ColorNames.nameOf(fil.color)}) ${fil.name}"
            }
            McpToolResult.text("Synced ${printerSlots.size} filament slot(s). Project now has ${refreshed.size} physical filaments:\n${summary.joinToString("\n")}")
        }

        registry.registerTool(
            name = "get_preflight_diagnostics",
            description = "Get slice preflight check results, including non-manifold errors, warnings, and bed boundaries.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")

            val activePlateId = project.view.activePlate?.id
                ?: return@registerTool McpToolResult.text("No active plate in workspace.")

            val preflightFuture = project.preflight(activePlateId)
            val preflight = try {
                preflightFuture.get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Preflight check failed: ${t.message}")
            }

            val issues = preflight.issues.map { issue ->
                mapOf(
                    "code" to issue.code.name,
                    "severity" to issue.severity.name,
                    "message" to String(CharArray(issue.message.size) { issue.message[it].toChar() }),
                )
            }

            val summary = mapOf(
                "can_slice" to preflight.summary.canSlice,
                "blocking_count" to preflight.summary.blockingCount,
                "issue_count" to preflight.summary.issueCount,
                "omission_count" to preflight.summary.omissionCount,
                "issues" to issues,
            )

            McpToolResult.text(McpJson.stringify(summary, indent = 2))
        }

        registry.registerTool(
            name = "smart_paint_describe",
            description = "Query minimal geometry characteristics (facet count, bounding extents in mm) of the selected model volume for Smart Paint planning.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "volume_id" to mapOf(
                        "type" to "string",
                        "description" to "Optional volume ID to describe. Defaults to currently selected volume.",
                    ),
                ),
                "additionalProperties" to false,
            ),
        ) { args ->
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")
            val volumeId = (args["volume_id"] as? String)?.takeIf { it.isNotBlank() }
                ?: (try { project.workspace.selectedVolumeId().get() } catch (_: Throwable) { null })
                ?: return@registerTool McpToolResult.error("No 3D model volume is available on the build plate.")

            val geomJson = try {
                project.workspace.smartPaintDescribe(volumeId).get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to describe geometry: ${t.message}")
            }

            McpToolResult.text(geomJson)
        }

        registry.registerTool(
            name = "smart_paint_propose",
            description = "Propose and project Smart Paint regions onto the selected model mesh using natural language prompts or explicit bounding boxes/normal cones. Returns resolved regions with facet counts and coverage percentages.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "volume_id" to mapOf(
                        "type" to "string",
                        "description" to "Optional volume ID. Defaults to selected volume.",
                    ),
                    "prompt" to mapOf(
                        "type" to "string",
                        "description" to "Natural language region prompt (e.g. 'top half', 'overhangs for support', 'base', 'front surface').",
                    ),
                    "proposal" to mapOf(
                        "type" to "object",
                        "description" to "Optional raw SmartPaintProposal object with schemaVersion: 1 and regions.",
                    ),
                ),
                "additionalProperties" to false,
            ),
        ) { args ->
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")
            val volumeId = (args["volume_id"] as? String)?.takeIf { it.isNotBlank() }
                ?: (try { project.workspace.selectedVolumeId().get() } catch (_: Throwable) { null })
                ?: return@registerTool McpToolResult.error("No 3D model volume is available on the build plate.")

            val prompt = (args["prompt"] as? String).orEmpty()
            val rawProposal = args["proposal"]

            val proposalJson = if (rawProposal != null) {
                if (rawProposal is String) rawProposal else McpJson.stringify(rawProposal)
            } else {
                dev.orcaxr.nativeapp.project.SmartPaintHelper.generateProposal(
                    context = project.getApplication(),
                    volumeId = volumeId,
                    prompt = prompt.ifBlank { "top and bottom regions" },
                    imageUri = null,
                    workspace = project.workspace,
                )
            }

            val validationJson = dev.orcaxr.core.ProjectSmartPaint.validateProposal(proposalJson)
            val validation = McpJson.parseObject(validationJson)
            if (validation?.get("valid") != true) {
                return@registerTool McpToolResult.error("Invalid Smart Paint proposal: ${validation?.get("message") ?: "Validation failed"}")
            }

            val projectionJson = try {
                project.workspace.smartPaintProject(volumeId, proposalJson).get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to project proposal onto model mesh: ${t.message}")
            }

            val projection = dev.orcaxr.nativeapp.project.parseSmartPaintProjection(projectionJson)
            val summary = mapOf(
                "volume_id" to volumeId,
                "proposal" to McpJson.parse(proposalJson),
                "total_triangle_count" to projection.triangleCount,
                "total_coverage_percent" to (projection.coverage * 100.0),
                "unassigned_triangles" to projection.unassignedTriangleCount,
                "regions" to projection.regions.map { r ->
                    mapOf(
                        "id" to r.id,
                        "label" to r.label,
                        "confidence" to r.confidence,
                        "triangle_count" to r.triangleIndices.size,
                        "coverage_percent" to (r.coverage * 100.0),
                    )
                },
            )

            McpToolResult.text(McpJson.stringify(summary, indent = 2))
        }

        registry.registerTool(
            name = "smart_paint_apply",
            description = "Apply Smart Paint assignments to the model volume in an atomic, undoable commit. Maps region IDs to filament slots or states ('enforce', 'block', 'avoid', 'prefer', 'fuzzy').",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "volume_id" to mapOf(
                        "type" to "string",
                        "description" to "Optional volume ID. Defaults to selected volume.",
                    ),
                    "channel" to mapOf(
                        "type" to "string",
                        "description" to "Paint channel: 'color' (default), 'support', 'seam', 'fuzzy_skin'.",
                    ),
                    "proposal" to mapOf(
                        "description" to "The proposal JSON object or string previously validated.",
                    ),
                    "assignments" to mapOf(
                        "type" to "object",
                        "description" to "Map of region IDs/labels to filament slot numbers (e.g. {'region_top': 2, 'region_bottom': 1}) or channel states ('enforce', 'block', 'avoid', 'prefer', 'fuzzy').",
                    ),
                ),
                "required" to listOf("proposal", "assignments"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")
            val volumeId = (args["volume_id"] as? String)?.takeIf { it.isNotBlank() }
                ?: (try { project.workspace.selectedVolumeId().get() } catch (_: Throwable) { null })
                ?: return@registerTool McpToolResult.error("No 3D model volume is available on the build plate.")

            val channel = (args["channel"] as? String)?.takeIf { it.isNotBlank() } ?: "color"
            val rawProposal = args["proposal"]
                ?: return@registerTool McpToolResult.error("Missing required parameter: proposal")
            @Suppress("UNCHECKED_CAST")
            val assignmentsMap = args["assignments"] as? Map<*, *>
                ?: return@registerTool McpToolResult.error("Missing or invalid assignments object")

            val proposalJson = if (rawProposal is String) rawProposal else McpJson.stringify(rawProposal)

            // Auto-sync missing color filaments (same as smart_paint).
            if (channel.equals("color", ignoreCase = true)) {
                val physical = project.view.filaments.options.filter { !it.mixed }
                val missingColors = mutableListOf<Pair<String, String>>()
                for ((_, value) in assignmentsMap) {
                    val valStr = value?.toString()?.trim() ?: continue
                    if (valStr.equals("unpainted", ignoreCase = true) || valStr.equals("erase", ignoreCase = true)) continue
                    if (ColorNames.findFilamentIdByColorOrNumber(valStr, physical) != null) continue
                    val hex = ColorNames.hexForColorName(valStr) ?: continue
                    if (physical.any { it.color.equals(hex, ignoreCase = true) }) continue
                    if (missingColors.none { it.first.equals(hex, ignoreCase = true) }) {
                        missingColors.add(hex to valStr)
                    }
                }
                if (missingColors.isNotEmpty()) {
                    val nextToolId = (physical.maxOfOrNull { it.toolId ?: 0 } ?: (physical.size - 1)) + 1
                    val slots = missingColors.mapIndexed { i, (hex, _) ->
                        ProjectIntents.PrinterSlot(
                            toolId = (nextToolId + i).toLong(),
                            color = hex.map { it.code },
                            material = "PLA".map { it.code },
                            subType = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
                            vendor = ProjectIntents.OptionalText.Absent(ProjectIntents.Empty),
                        )
                    }
                    val newIds = List(slots.size) { java.util.UUID.randomUUID().toString() }
                    try {
                        project.workspace.syncPhysicalFilaments(slots, newIds).get()
                    } catch (_: Throwable) { /* Non-fatal */ }
                }
            }

            val projectionJson = try {
                project.workspace.smartPaintProject(volumeId, proposalJson).get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to project proposal: ${t.message}")
            }

            val projection = dev.orcaxr.nativeapp.project.parseSmartPaintProjection(projectionJson)
            val filaments = project.view.filaments.options.filter { !it.mixed }
            val assignmentsList = dev.orcaxr.nativeapp.project.SmartPaintHelper.resolveAssignments(assignmentsMap, projection, filaments, channel)

            if (assignmentsList.isEmpty()) {
                return@registerTool McpToolResult.error("None of the specified assignments matched the proposed region IDs (${projection.regions.map { it.id }})")
            }

            val assignmentsJson = dev.orcaxr.nativeapp.project.SmartPaintHelper.resolveAssignmentsJson(assignmentsMap, projection, filaments, channel)

            val batchIntentJson = try {
                project.workspace.smartPaintBuildBatch(
                    volumeId,
                    channel.lowercase(),
                    proposalJson,
                    assignmentsJson,
                ).get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to build Smart Paint batch: ${t.message}")
            }

            try {
                project.workspace.applySmartPaintBatch(batchIntentJson).get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to apply Smart Paint batch to project: ${t.message}")
            }

            McpToolResult.text("Successfully applied Smart Paint ($channel) across ${assignmentsList.size} region(s) onto the model.")
        }

        registry.registerTool(
            name = "smart_paint",
            description = "Perform AI smart painting on the selected 3D model in a single step. Automatically proposes regions from prompt and assigns filaments or support states.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "volume_id" to mapOf(
                        "type" to "string",
                        "description" to "Optional volume ID. Defaults to selected volume.",
                    ),
                    "prompt" to mapOf(
                        "type" to "string",
                        "description" to "Description of regions to paint (e.g. 'top and bottom', 'overhangs', 'front face').",
                    ),
                    "channel" to mapOf(
                        "type" to "string",
                        "description" to "Target channel: 'color' (default), 'support', 'seam', 'fuzzy_skin'.",
                    ),
                    "assignments" to mapOf(
                        "type" to "object",
                        "description" to "Map of region keywords or IDs to slot numbers/colors (e.g. {'top': 2, 'bottom': 1} or {'top': 'blue', 'bottom': 'white'} or {'overhang': 'enforce'}).",
                    ),
                ),
                "required" to listOf("assignments"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")
            val volumeId = (args["volume_id"] as? String)?.takeIf { it.isNotBlank() }
                ?: (try { project.workspace.selectedVolumeId().get() } catch (_: Throwable) { null })
                ?: return@registerTool McpToolResult.error("No 3D model volume is available on the build plate.")

            val channel = (args["channel"] as? String)?.takeIf { it.isNotBlank() } ?: "color"
            @Suppress("UNCHECKED_CAST")
            val assignmentsMap = args["assignments"] as? Map<*, *>
                ?: return@registerTool McpToolResult.error("Missing or invalid assignments object")

            val prompt = (args["prompt"] as? String)?.takeIf { it.isNotBlank() }
                ?: assignmentsMap.keys.joinToString(" and ") { it.toString() }

            // Auto-sync missing color filaments before painting.
            // If any assignment value is a color name that doesn't match an existing
            // filament, add it to the project so facet strokes can reference it.
            run {
                val physical = project.view.filaments.options.filter { !it.mixed }
                val missingColors = mutableListOf<Pair<String, String>>() // (color hex, name)
                for ((_, value) in assignmentsMap) {
                    val valStr = value?.toString()?.trim() ?: continue
                    if (valStr.equals("unpainted", ignoreCase = true) || valStr.equals("erase", ignoreCase = true)) continue
                    // Already resolvable?
                    if (ColorNames.findFilamentIdByColorOrNumber(valStr, physical) != null) continue
                    // Is it a known color name we can convert to hex?
                    val hex = ColorNames.hexForColorName(valStr) ?: continue
                    // Already have this exact hex?
                    if (physical.any { it.color.equals(hex, ignoreCase = true) }) continue
                    if (missingColors.none { it.first.equals(hex, ignoreCase = true) }) {
                        missingColors.add(hex to valStr)
                    }
                }
                if (missingColors.isNotEmpty()) {
                    val nextToolId = (physical.maxOfOrNull { it.toolId ?: 0 } ?: (physical.size - 1)) + 1
                    val slots = missingColors.mapIndexed { i, (hex, _) ->
                        dev.orcaxr.core.ProjectIntents.PrinterSlot(
                            toolId = (nextToolId + i).toLong(),
                            color = hex.map { it.code },
                            material = "PLA".map { it.code },
                            subType = dev.orcaxr.core.ProjectIntents.OptionalText.Absent(dev.orcaxr.core.ProjectIntents.Empty),
                            vendor = dev.orcaxr.core.ProjectIntents.OptionalText.Absent(dev.orcaxr.core.ProjectIntents.Empty),
                        )
                    }
                    val newIds = List(slots.size) { java.util.UUID.randomUUID().toString() }
                    try {
                        project.workspace.syncPhysicalFilaments(slots, newIds).get()
                    } catch (_: Throwable) {
                        // Non-fatal: proceed with existing filaments; the paint may fail below.
                    }
                }
            }

            val proposalJson = dev.orcaxr.nativeapp.project.SmartPaintHelper.generateProposal(
                context = project.getApplication(),
                volumeId = volumeId,
                prompt = prompt,
                imageUri = null,
                workspace = project.workspace,
            )

            val projectionJson = try {
                project.workspace.smartPaintProject(volumeId, proposalJson).get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to project proposal: ${t.message}")
            }

            val projection = dev.orcaxr.nativeapp.project.parseSmartPaintProjection(projectionJson)
            val filaments = project.view.filaments.options.filter { !it.mixed }
            val assignmentsList = dev.orcaxr.nativeapp.project.SmartPaintHelper.resolveAssignments(assignmentsMap, projection, filaments, channel)

            if (assignmentsList.isEmpty()) {
                return@registerTool McpToolResult.error("None of the specified assignments (${assignmentsMap.keys}) matched the proposed region IDs (${projection.regions.map { it.id }})")
            }

            val assignmentsJson = dev.orcaxr.nativeapp.project.SmartPaintHelper.resolveAssignmentsJson(assignmentsMap, projection, filaments, channel)

            val batchIntentJson = try {
                project.workspace.smartPaintBuildBatch(
                    volumeId,
                    channel.lowercase(),
                    proposalJson,
                    assignmentsJson,
                ).get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to build Smart Paint batch: ${t.message}")
            }

            try {
                project.workspace.applySmartPaintBatch(batchIntentJson).get()
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to apply Smart Paint batch to project: ${t.message}")
            }

            McpToolResult.text("Successfully smart painted ($channel) on model: ${assignmentsList.size} region(s) painted (${projection.regions.map { it.label }.joinToString(", ")})")
        }

        registry.registerTool(
            name = "semantic_paint_model",
            description = "Paint a 3D model with realistic or iconic character colors (e.g. 'Pikachu', 'Pumpkin', 'Frog', 'Fox', 'Benchy', or any custom theme) using either available filaments (closest Delta-E match) or Full Spectrum colors (auto-provisioning exact matching filaments).\n" +
                "Examples:\n" +
                "- Paint as Pikachu with available colors: {\"character\": \"Pikachu\", \"palette_mode\": \"available_only\"}\n" +
                "- Paint as Pikachu with full spectrum: {\"character\": \"Pikachu\", \"palette_mode\": \"full_spectrum\"}",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "character" to mapOf(
                        "type" to "string",
                        "description" to "The character, object, or theme to paint the model as (e.g. 'Pikachu', 'Pumpkin', 'Frog', 'Fox', 'Benchy', 'Charmander', 'Iron Man').",
                    ),
                    "palette_mode" to mapOf(
                        "type" to "string",
                        "enum" to listOf("available_only", "full_spectrum"),
                        "description" to "Color palette mode: 'available_only' (uses only currently loaded filaments via CIEDE2000 Delta-E) or 'full_spectrum' (auto-provisions exact required colors into the project).",
                    ),
                    "volume_id" to mapOf(
                        "type" to "string",
                        "description" to "Optional volume ID to paint. Defaults to currently selected or primary model volume.",
                    ),
                ),
                "required" to listOf("character"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")
            ensureModelSelected(project)

            val character = args["character"] as? String
                ?: return@registerTool McpToolResult.error("Missing required parameter: character")
            val mode = (args["palette_mode"] as? String)?.lowercase() ?: "full_spectrum"

            val volumeId = (args["volume_id"] as? String)?.takeIf { it.isNotBlank() }
                ?: (try { project.workspace.selectedVolumeId().get() } catch (_: Throwable) { null })
                ?: return@registerTool McpToolResult.error("No 3D model volume is available on the build plate.")

            val physical = project.view.filaments.options.filter { !it.mixed }
            val result = try {
                dev.orcaxr.nativeapp.project.SemanticCharacterPainter.paintModel(
                    context = project.getApplication(),
                    workspace = project.workspace,
                    volumeId = volumeId,
                    characterOrTheme = character,
                    paletteMode = mode,
                    currentFilaments = physical,
                )
            } catch (t: Throwable) {
                return@registerTool McpToolResult.error("Failed to paint model as '$character': ${t.message}")
            }

            McpToolResult.text(result.spokenSummary)
        }

        registry.registerTool(
            name = "add_primitive",
            description = "Add a 3D primitive shape to the active build plate (cube, cylinder, sphere, cone, disc, torus).",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "shape" to mapOf(
                        "type" to "string",
                        "enum" to listOf("cube", "cylinder", "sphere", "cone", "disc", "torus"),
                        "description" to "The primitive shape to add (defaults to cube).",
                    ),
                ),
                "required" to listOf("shape"),
                "additionalProperties" to false,
            ),
        ) { args ->
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")
            val shapeName = (args["shape"] as? String)?.lowercase()?.trim() ?: "cube"
            val shape = dev.orcaxr.core.PrimitiveShape.entries.firstOrNull { it.name.lowercase() == shapeName }
                ?: return@registerTool McpToolResult.error("Unknown shape '$shapeName'. Available: cube, cylinder, sphere, cone, disc, torus")
            try {
                val added = project.workspace.addPrimitive(shape).get()
                McpToolResult.text("Successfully added ${shape.name.lowercase()} to build plate (objectId: ${added?.objectId}, instanceId: ${added?.instanceId})")
            } catch (t: Throwable) {
                McpToolResult.error("Failed to add ${shape.name.lowercase()}: ${t.message}")
            }
        }

        registry.registerTool(
            name = "list_recent_projects",
            description = "List recent project documents available on this device (name, uri).",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")
            val list = project.recent.mapIndexed { index, entry ->
                mapOf(
                    "index" to index + 1,
                    "name" to entry.name,
                    "uri" to entry.uri,
                )
            }
            McpToolResult.text(McpJson.stringify(mapOf("recent_projects" to list), indent = 2))
        }

        registry.registerTool(
            name = "open_recent_project",
            description = "Open a recent project document by its 1-based index (from list_recent_projects) or exact/partial name.",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "index" to mapOf(
                        "type" to "integer",
                        "description" to "1-based index of the project in recent list.",
                    ),
                    "name" to mapOf(
                        "type" to "string",
                        "description" to "File name or partial name of the recent project (e.g. 'setzkasten.3mf').",
                    ),
                ),
                "additionalProperties" to false,
            ),
        ) { args ->
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")
            val index = (args["index"] as? Number)?.toInt()
            val targetName = (args["name"] as? String)?.trim()?.lowercase()
            val entry = if (index != null && index in 1..project.recent.size) {
                project.recent[index - 1]
            } else if (!targetName.isNullOrEmpty()) {
                project.recent.firstOrNull { it.name.lowercase().contains(targetName) }
                    ?: return@registerTool McpToolResult.error("No recent project matches name '$targetName'. Available: ${project.recent.map { it.name }}")
            } else {
                return@registerTool McpToolResult.error("Specify either 'index' (e.g. 1) or 'name' (e.g. 'setzkasten.3mf').")
            }

            android.os.Handler(android.os.Looper.getMainLooper()).post {
                try {
                    project.openRecent(entry)
                } catch (t: Throwable) {
                    dev.orcaxr.nativeapp.mcp.McpLogBuffer.log("OrcaXRProject", "Failed to open recent project: ${t.message}")
                }
            }
            McpToolResult.text("Opening recent project '${entry.name}'...")
        }

        registry.registerTool(
            name = "disable_wipe_tower",
            description = "Disable or remove the prime/wipe tower from the active plate (resolves 'wipe-tower-outside-build-volume' preflight errors).",
            inputSchema = mapOf(
                "type" to "object",
                "properties" to emptyMap<String, Any>(),
                "additionalProperties" to false,
            ),
        ) {
            val project = context.project
                ?: return@registerTool McpToolResult.error("Project workspace is not available.")
            try {
                project.workspace.disableWipeTower().get()
                McpToolResult.text("Successfully disabled wipe tower on active plate.")
            } catch (t: Throwable) {
                McpToolResult.error("Failed to disable wipe tower: ${t.message}")
            }
        }
    }

    private fun ensureModelSelected(project: dev.orcaxr.nativeapp.project.ProjectModel) {
        if (project.view.selection.total == 0L) {
            val rowKey = project.view.rows.firstOrNull { it.kind.name == "Instance" }?.key
                ?: project.view.rows.firstOrNull { it.kind.name == "Object" }?.key
            if (rowKey != null) {
                val keyStr = String(CharArray(rowKey.size) { rowKey[it].toChar() })
                try {
                    project.workspace.selectRow(keyStr, dev.orcaxr.core.ProjectRowSelection.Replace).get()
                } catch (_: Throwable) {}
            }
        }
    }
}
