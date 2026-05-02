package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.BedCollision
import dev.orcaxr.app.BedFit
import dev.orcaxr.app.GizmoTool
import dev.orcaxr.app.PaintBrush
import dev.orcaxr.app.PaintMode
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.SliceResult
import dev.orcaxr.app.SliceUiState
import dev.orcaxr.app.SlicerProfile
import dev.orcaxr.app.WorkspaceMode
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject

/**
 * Tools that read or mutate in-session workspace state (placedModels,
 * gizmo tool, paint brush, etc.). Read tools snapshot
 * [WorkspaceModel]'s StateFlows; mutator tools post a
 * [WorkspaceAction] which MainActivity's `BindWorkspaceModel`
 * collector turns into a setter call.
 *
 * Tier-A surface (this commit):
 * - Reads: get_workspace_state, list_placed_models.
 * - Mutators that resolve via the action channel:
 *   set_gizmo_tool, set_workspace_mode, set_active_plate,
 *   select_models, clear_selection, set_layer_height_override,
 *   set_paint_mode, set_paint_brush, set_max_layer, switch_profile,
 *   select_printer, set_show_travels, set_toolpath_tubes,
 *   transform_model, delete_models.
 *
 * If MainActivity isn't currently attached (app backgrounded /
 * shell torn down), mutator tools return an isError result rather
 * than silently dropping the action.
 */
internal object WorkspaceTools {

    fun all(ctx: ToolContext): List<Tool> {
        val workspace = WorkspaceModel.get()
        return listOf(
            GetWorkspaceState(workspace, ctx),
            ListPlacedModels(workspace),
            SetGizmoTool(workspace),
            SetWorkspaceMode(workspace),
            SetActivePlate(workspace),
            SelectModels(workspace),
            ClearSelection(workspace),
            SetLayerHeightOverride(workspace),
            SetPaintMode(workspace),
            SetPaintBrush(workspace),
            SetMaxLayer(workspace),
            SwitchProfile(workspace),
            SelectPrinter(workspace, ctx),
            SetShowTravels(workspace),
            SetToolpathTubes(workspace),
            TransformModel(workspace),
            DeleteModels(workspace),
            // Tier-B: long-running pipelines that route through the
            // matching MainActivity buttons (Slice / Save / Auto-arrange).
            SliceActivePlate(workspace),
            CancelSlice(workspace),
            AutoArrangePlate(workspace),
            DropToBed(workspace),
            SaveGcodeToDownloads(workspace),
            SaveProjectAs3mf(workspace),
            SaveModelAsStl(workspace),
        )
    }

    // ---- Encoders shared by read tools ----

    private fun encodePlacedModel(m: PlacedModel): JSONObject = JSONObject().apply {
        put("id", m.id)
        put("label", m.label)
        put("source_path", m.source.absolutePath)
        if (m.originalSource != null) put("original_source_path", m.originalSource.absolutePath)
        if (m.groupId != null) put("group_id", m.groupId)
        put("group_ordinal", m.groupOrdinal)
        put("plate_id", m.plateId)
        put("translate_x_mm", m.translateXmm)
        put("translate_y_mm", m.translateYmm)
        put("translate_z_mm", m.translateZmm)
        put("rot_x_deg", m.rotXDeg)
        put("rot_y_deg", m.rotYDeg)
        put("rot_z_deg", m.rotZDeg)
        put("scale_x_pct", m.scaleXPct)
        put("scale_y_pct", m.scaleYPct)
        put("scale_z_pct", m.scaleZPct)
        put("mirror_x", m.mirrorX)
        put("mirror_y", m.mirrorY)
        put("mirror_z", m.mirrorZ)
        put("base_bbox_x_mm", m.baseBboxXmm)
        put("base_bbox_y_mm", m.baseBboxYmm)
        put("base_bbox_z_mm", m.baseBboxZmm)
        // Paint summary — counts only, not the full per-triangle byte
        // arrays. Tools that need the actual paint state should request
        // a dedicated tool (not yet implemented).
        val paint = JSONObject()
        paint.put("color_painted_tris", m.paintFilamentIndex?.count { it > 0 } ?: 0)
        paint.put("support_painted_tris", m.supportFlags?.count { it > 0 } ?: 0)
        paint.put("seam_painted_tris", m.seamFlags?.count { it > 0 } ?: 0)
        paint.put("fuzzy_skin_painted_tris", m.fuzzySkinFlags?.count { it > 0 } ?: 0)
        paint.put("brim_ear_count", m.brimEars.size)
        put("paint", paint)
    }

    private fun encodeProfile(p: SlicerProfile): JSONObject = JSONObject().apply {
        put("id", p.id)
        put("display_name", p.displayName)
        put("description", p.description)
        if (p.machineName != null) put("machine_name", p.machineName)
        if (p.processName != null) put("process_name", p.processName)
        if (p.filamentName != null) put("filament_name", p.filamentName)
    }

    private fun encodePaintBrush(b: PaintBrush): JSONObject = JSONObject().apply {
        put("mode", b.mode.name)
        put("active_slot", b.activeSlot)
        put("radius_mm", b.radiusMm)
        put("smart_fill", b.smartFill)
        put("smart_fill_angle_deg", b.smartFillAngleDeg)
    }

    private fun encodeBedFit(f: BedFit?): JSONObject? {
        if (f == null) return null
        val out = JSONObject()
        out.put("size_text", f.sizeText)
        when (f) {
            is BedFit.Ok -> out.put("status", "ok")
            is BedFit.Warn -> {
                out.put("status", "warn")
                out.put("reason", f.reason)
            }
        }
        return out
    }

    private fun encodeBedCollision(r: BedCollision.Result?): JSONObject? {
        if (r == null) return null
        val out = JSONObject()
        when (r) {
            is BedCollision.Result.Ok -> out.put("status", "ok")
            is BedCollision.Result.Off -> {
                out.put("status", "off")
                out.put("offending_tri_count", r.offendingTriCount)
                out.put("total_tri_count", r.totalTriCount)
                out.put("overflow_x", r.overflowX)
                out.put("overflow_y", r.overflowY)
                out.put("worst_overflow_x_mm", r.worstOverflowXmm)
                out.put("worst_overflow_y_mm", r.worstOverflowYmm)
            }
        }
        return out
    }

    private fun encodeSliceState(s: SliceUiState): JSONObject = JSONObject().apply {
        when (s) {
            SliceUiState.Idle -> put("kind", "idle")
            is SliceUiState.Slicing -> {
                put("kind", "slicing")
                put("source_label", s.sourceLabel)
                put("percent", s.percent)
                put("message", s.message)
                put("started_at_ms", s.startedAtMs)
            }
            is SliceUiState.Done -> {
                put("kind", "done")
                put("source_label", s.sourceLabel)
                val r = s.result
                when (r) {
                    is SliceResult.Success -> {
                        put("status", "success")
                        put("output_path", r.outputPath)
                        put("size_bytes", r.sizeBytes)
                    }
                    is SliceResult.NativeError -> {
                        put("status", "native_error")
                        put("code", r.code)
                        put("message", r.message)
                    }
                }
            }
        }
    }

    // ---- Read tools ----

    class GetWorkspaceState(
        private val ws: WorkspaceModel,
        private val tctx: ToolContext,
    ) : Tool {
        override val name = "get_workspace_state"
        override val description =
            "Snapshot the entire in-session workspace: workspace_mode (Prepare|Preview), " +
                "active_plate_id, gizmo_tool, paint_brush {mode, active_slot, radius_mm, " +
                "smart_fill, smart_fill_angle_deg}, selected_profile {id, name, machine, process, " +
                "filament}, layer_height_override, selected_printer_id, slice_state {kind, percent, " +
                "...}, max_layer (toolpath scrubber), bed_fit, bed_collision, show_travels, " +
                "toolpath_tubes, placed_models [...], selected_model_ids. Use this as the first " +
                "call when an LLM needs to know what's on the bed before making a decision."
        override val inputSchema = Schemas.empty()

        override suspend fun call(args: JSONObject): ToolResult {
            val state = JSONObject()
            state.put("attached", ws.attached.value)
            state.put("workspace_mode", ws.workspaceMode.value.name)
            state.put("active_plate_id", ws.activePlateId.value)
            state.put("gizmo_tool", ws.gizmoTool.value.name)
            state.put("paint_brush", encodePaintBrush(ws.paintBrush.value))
            ws.selectedProfile.value?.let { state.put("selected_profile", encodeProfile(it)) }
            state.put("layer_height_override", ws.layerHeightOverride.value)
            ws.selectedPrinterId.value?.let { state.put("selected_printer_id", it) }
            state.put("slice_state", encodeSliceState(ws.sliceState.value))
            ws.maxLayer.value?.let { state.put("max_layer", it) }
            encodeBedFit(ws.bedFit.value)?.let { state.put("bed_fit", it) }
            encodeBedCollision(ws.bedCollision.value)?.let { state.put("bed_collision", it) }
            state.put("show_travels", ws.showTravels.value)
            state.put("toolpath_tubes", ws.toolpathTubes.value)

            val plate = ws.activePlateId.value
            val placed = ws.placedModels.value
            val onActivePlate = placed.filter { it.plateId == plate }
            val placedJson = JSONArray()
            for (m in onActivePlate) placedJson.put(encodePlacedModel(m))
            state.put("placed_models", placedJson)
            state.put("placed_models_total_all_plates", placed.size)
            val sel = JSONArray()
            for (id in ws.selectedModelIds.value) sel.put(id)
            state.put("selected_model_ids", sel)

            val body = JSONObject().apply {
                put("ok", true)
                put("workspace", state)
            }

            // Human-friendly summary so an LLM sees the highlights up
            // top before parsing the structured tree.
            val text = buildString {
                append("Workspace: ${ws.workspaceMode.value}\n")
                append("Active plate: $plate (${onActivePlate.size} models on plate, ${placed.size} total)\n")
                ws.selectedProfile.value?.let { append("Profile: ${it.displayName}\n") }
                ws.selectedPrinterId.value?.let { id ->
                    append("Printer: $id\n")
                }
                append("Gizmo: ${ws.gizmoTool.value} | Paint: ${ws.paintBrush.value.mode}\n")
                val ss = ws.sliceState.value
                append("Slice: ")
                append(when (ss) {
                    SliceUiState.Idle -> "idle"
                    is SliceUiState.Slicing -> "slicing ${ss.percent}%"
                    is SliceUiState.Done -> "done (${ss.sourceLabel})"
                })
            }
            return ToolResult.ok(text, body)
        }
    }

    class ListPlacedModels(private val ws: WorkspaceModel) : Tool {
        override val name = "list_placed_models"
        override val description =
            "List the models currently on the bed. Filterable by plate_id or " +
                "selected_only. Same per-model shape as get_workspace_state.placed_models."
        override val inputSchema = Schemas.obj(
            properties = mapOf(
                "plate_id" to Schemas.integer("Filter to this plate (default: all plates)"),
                "selected_only" to Schemas.bool("If true, return only currently-selected models"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val plateFilter = if (args.has("plate_id")) args.optInt("plate_id", -1) else null
            val selectedOnly = args.optBoolean("selected_only", false)
            val sel = ws.selectedModelIds.value
            val list = ws.placedModels.value.let { models ->
                var out = models
                if (plateFilter != null) out = out.filter { it.plateId == plateFilter }
                if (selectedOnly) out = out.filter { it.id in sel }
                out
            }
            val arr = JSONArray()
            for (m in list) arr.put(encodePlacedModel(m))
            val body = JSONObject().apply {
                put("ok", true)
                put("count", list.size)
                put("placed_models", arr)
            }
            val text = if (list.isEmpty()) "(no models)"
                else list.joinToString("\n") { m ->
                    "- ${m.label}  plate=${m.plateId}  scale=${m.scaleXPct}/${m.scaleYPct}/${m.scaleZPct}%  rot=${m.rotZDeg}°  id=${m.id}"
                }
            return ToolResult.ok(text, body)
        }
    }

    // ---- Mutator helper ----

    private fun requireAttached(ws: WorkspaceModel): ToolResult? {
        if (ws.attached.value) return null
        return ToolResult.error(
            "OrcaXR's main window isn't currently attached (app backgrounded?). " +
                "Bring the app to the foreground and retry.",
        )
    }

    private fun success(message: String, extra: JSONObject = JSONObject()): ToolResult {
        val body = JSONObject().apply { put("ok", true) }
        val keys = extra.keys()
        while (keys.hasNext()) { val k = keys.next(); body.put(k, extra.get(k)) }
        return ToolResult.ok(message, body)
    }

    // ---- Mutator tools ----

    class SetGizmoTool(private val ws: WorkspaceModel) : Tool {
        override val name = "set_gizmo_tool"
        override val description =
            "Switch the active transform tool. Move/Rotate/Scale show the gizmo around the " +
                "selected model; Select hides the gizmo."
        override val inputSchema = Schemas.obj(
            required = listOf("tool"),
            properties = mapOf("tool" to Schemas.string("One of: Select, Move, Rotate, Scale")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val name = args.optString("tool")
            val tool = runCatching { GizmoTool.valueOf(name) }.getOrNull()
                ?: return ToolResult.error("Unknown tool '$name'. Use Select|Move|Rotate|Scale.")
            ws.emit(WorkspaceAction.SetGizmoTool(tool))
            return success("Gizmo tool set to $tool", JSONObject().apply { put("gizmo_tool", tool.name) })
        }
    }

    class SetWorkspaceMode(private val ws: WorkspaceModel) : Tool {
        override val name = "set_workspace_mode"
        override val description =
            "Switch between Prepare (model editing) and Preview (toolpath viewer). " +
                "Preview only makes sense after a successful slice."
        override val inputSchema = Schemas.obj(
            required = listOf("mode"),
            properties = mapOf("mode" to Schemas.string("Prepare or Preview")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val raw = args.optString("mode")
            val mode = runCatching { WorkspaceMode.valueOf(raw) }.getOrNull()
                ?: return ToolResult.error("Unknown mode '$raw'. Use Prepare|Preview.")
            ws.emit(WorkspaceAction.SetWorkspaceMode(mode))
            return success("Workspace set to $mode", JSONObject().apply { put("workspace_mode", mode.name) })
        }
    }

    class SetActivePlate(private val ws: WorkspaceModel) : Tool {
        override val name = "set_active_plate"
        override val description =
            "Switch the visible plate. Filters the model list to models with that plate_id."
        override val inputSchema = Schemas.obj(
            required = listOf("plate_id"),
            properties = mapOf("plate_id" to Schemas.integer("Plate id (1+; plate 1 is always present)")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val id = args.optInt("plate_id", -1)
            if (id < 1) return ToolResult.error("plate_id must be >= 1.")
            ws.emit(WorkspaceAction.SetActivePlateId(id))
            return success("Active plate set to $id", JSONObject().apply { put("active_plate_id", id) })
        }
    }

    class SelectModels(private val ws: WorkspaceModel) : Tool {
        override val name = "select_models"
        override val description =
            "Replace (or extend, if additive=true) the selection with these model ids. " +
                "Pass an empty list with additive=false to clear the selection."
        override val inputSchema = Schemas.obj(
            required = listOf("model_ids"),
            properties = mapOf(
                "model_ids" to Schemas.stringArray("Model ids from list_placed_models"),
                "additive" to Schemas.bool("If true, union with current selection"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val rawIds = args.optJSONArray("model_ids") ?: JSONArray()
            val ids = (0 until rawIds.length()).map { rawIds.optString(it) }
                .filter { it.isNotBlank() }.toSet()
            val additive = args.optBoolean("additive", false)
            ws.emit(WorkspaceAction.SetSelectedModels(ids, additive))
            return success(
                "Selection ${if (additive) "extended" else "set to"} ${ids.size} model(s).",
                JSONObject().apply {
                    put("selected_count", ids.size)
                    put("additive", additive)
                },
            )
        }
    }

    class ClearSelection(private val ws: WorkspaceModel) : Tool {
        override val name = "clear_selection"
        override val description = "Deselect all models."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            ws.emit(WorkspaceAction.SetSelectedModels(emptySet(), additive = false))
            return success("Selection cleared.")
        }
    }

    class SetLayerHeightOverride(private val ws: WorkspaceModel) : Tool {
        override val name = "set_layer_height_override"
        override val description =
            "Set the layer-height override (in mm) applied on top of the active profile. " +
                "Pass an empty string to clear and use the profile default. Common values: " +
                "0.08 (Fine), 0.12 (Detail), 0.16, 0.20 (Standard), 0.24, 0.28 (Draft). " +
                "Effective range is clamped 0.05..0.50 at slice time."
        override val inputSchema = Schemas.obj(
            required = listOf("value"),
            properties = mapOf("value" to Schemas.string("Layer height in mm, or empty string")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val v = args.optString("value", "")
            // Light validation: empty is fine; non-empty must parse as
            // a positive float. The slicer does the real clamp.
            if (v.isNotBlank() && v.toFloatOrNull()?.let { it > 0f } != true) {
                return ToolResult.error("'$v' isn't a valid layer height (must parse as a positive number).")
            }
            ws.emit(WorkspaceAction.SetLayerHeightOverride(v))
            return success(
                if (v.isBlank()) "Layer-height override cleared." else "Layer height override set to $v mm.",
                JSONObject().apply { put("layer_height_override", v) },
            )
        }
    }

    class SetPaintMode(private val ws: WorkspaceModel) : Tool {
        override val name = "set_paint_mode"
        override val description =
            "Switch paint mode. Off disables painting (laser pointer drives the gizmo instead). " +
                "Color paints filament-slot tags into the per-triangle paint state. Support/Seam " +
                "modes drop enforcers/blockers. FuzzySkin marks regions for fuzzy texture. " +
                "BrimEars drops point anchors. LayOnFace re-orients the model to put the next-clicked " +
                "face on the bed (auto-resets to Off after one click)."
        override val inputSchema = Schemas.obj(
            required = listOf("mode"),
            properties = mapOf(
                "mode" to Schemas.string(
                    "One of: Off, Color, LayOnFace, SupportEnforcer, SupportBlocker, " +
                        "SeamEnforcer, SeamBlocker, FuzzySkin, BrimEars",
                ),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val raw = args.optString("mode")
            val mode = runCatching { PaintMode.valueOf(raw) }.getOrNull()
                ?: return ToolResult.error("Unknown paint mode '$raw'.")
            ws.emit(WorkspaceAction.SetPaintMode(mode))
            return success("Paint mode set to $mode", JSONObject().apply { put("paint_mode", mode.name) })
        }
    }

    class SetPaintBrush(private val ws: WorkspaceModel) : Tool {
        override val name = "set_paint_brush"
        override val description =
            "Update one or more paint-brush settings. Only fields you supply are changed. " +
                "active_slot is 1..32 (filament tag for color paint); 0 reserved for clear. " +
                "radius_mm is the flood-fill radius (presets 3 / 6 / 12 in the UI). smart_fill " +
                "switches to dihedral-angle flood from the click point."
        override val inputSchema = Schemas.obj(
            properties = mapOf(
                "active_slot" to Schemas.integer("Filament slot 1..32"),
                "radius_mm" to Schemas.number("Flood-fill radius in printer-frame mm"),
                "smart_fill" to Schemas.bool("Enable smart-fill (dihedral-angle flood)"),
                "smart_fill_angle_deg" to Schemas.number("Smart-fill angle gate, 0..180"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val update = WorkspaceAction.UpdatePaintBrush(
                activeSlot = if (args.has("active_slot")) args.getInt("active_slot") else null,
                radiusMm = if (args.has("radius_mm")) args.getDouble("radius_mm").toFloat() else null,
                smartFill = if (args.has("smart_fill")) args.getBoolean("smart_fill") else null,
                smartFillAngleDeg = if (args.has("smart_fill_angle_deg")) args.getDouble("smart_fill_angle_deg").toFloat() else null,
            )
            ws.emit(update)
            return success("Paint brush updated.", JSONObject().apply {
                update.activeSlot?.let { put("active_slot", it) }
                update.radiusMm?.let { put("radius_mm", it) }
                update.smartFill?.let { put("smart_fill", it) }
                update.smartFillAngleDeg?.let { put("smart_fill_angle_deg", it) }
            })
        }
    }

    class SetMaxLayer(private val ws: WorkspaceModel) : Tool {
        override val name = "set_max_layer"
        override val description =
            "Move the toolpath layer scrubber. Pass null/-1 to show all layers. " +
                "Only meaningful in Preview mode after a successful slice."
        override val inputSchema = Schemas.obj(
            properties = mapOf("layer" to Schemas.integer("Layer index, or -1/null for all layers")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val layer = if (args.has("layer") && !args.isNull("layer")) args.optInt("layer", -1) else -1
            val v = if (layer < 0) null else layer
            ws.emit(WorkspaceAction.SetMaxLayer(v))
            return success(
                if (v == null) "Showing all layers." else "Showing layers 0..$v.",
                JSONObject().apply { if (v != null) put("max_layer", v) },
            )
        }
    }

    class SwitchProfile(private val ws: WorkspaceModel) : Tool {
        override val name = "switch_profile"
        override val description =
            "Switch the active slicer profile by id. Use list_profiles to discover ids."
        override val inputSchema = Schemas.obj(
            required = listOf("profile_id"),
            properties = mapOf("profile_id" to Schemas.string("Profile id from list_profiles")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val id = args.optString("profile_id").trim()
            if (id.isEmpty()) return ToolResult.error("'profile_id' is required.")
            ws.emit(WorkspaceAction.SwitchProfile(id))
            return success("Switching profile to $id.", JSONObject().apply { put("profile_id", id) })
        }
    }

    class SelectPrinter(
        private val ws: WorkspaceModel,
        private val tctx: ToolContext,
    ) : Tool {
        override val name = "select_printer"
        override val description =
            "Set the active printer (the one Send-to-printer + status polling target). " +
                "Pass empty string or omit printer_id to clear the selection."
        override val inputSchema = Schemas.obj(
            properties = mapOf("printer_id" to Schemas.string("Printer id (or name) from list_printers; \"\" to clear")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val raw = args.optString("printer_id", "").trim()
            val resolved = if (raw.isEmpty()) {
                null
            } else {
                val list = tctx.printers.printers.first()
                list.firstOrNull { it.id == raw }?.id
                    ?: list.firstOrNull { it.name.equals(raw, ignoreCase = true) }?.id
                    ?: return ToolResult.error("No printer matches '$raw'.")
            }
            ws.emit(WorkspaceAction.SetSelectedPrinter(resolved))
            return success(
                if (resolved == null) "Cleared printer selection." else "Printer set to $resolved.",
                JSONObject().apply { if (resolved != null) put("selected_printer_id", resolved) },
            )
        }
    }

    class SetShowTravels(private val ws: WorkspaceModel) : Tool {
        override val name = "set_show_travels"
        override val description = "Toggle whether the toolpath GLB renders travel (non-extrusion) segments."
        override val inputSchema = Schemas.obj(
            required = listOf("value"),
            properties = mapOf("value" to Schemas.bool("True = render travels")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val v = args.optBoolean("value", false)
            ws.emit(WorkspaceAction.SetShowTravels(v))
            return success("show_travels = $v", JSONObject().apply { put("show_travels", v) })
        }
    }

    class SetToolpathTubes(private val ws: WorkspaceModel) : Tool {
        override val name = "set_toolpath_tubes"
        override val description =
            "Toggle toolpath rendering between 4-sided rectangular tubes (true) and single LINES (false)."
        override val inputSchema = Schemas.obj(
            required = listOf("value"),
            properties = mapOf("value" to Schemas.bool("True = tubes; false = lines")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val v = args.optBoolean("value", true)
            ws.emit(WorkspaceAction.SetToolpathTubes(v))
            return success("toolpath_tubes = $v", JSONObject().apply { put("toolpath_tubes", v) })
        }
    }

    class TransformModel(private val ws: WorkspaceModel) : Tool {
        override val name = "transform_model"
        override val description =
            "Apply absolute transforms to one model. Translation in mm (printer frame: " +
                "X = bed-X, Y = bed-Y, Z = print-height). Rotation in degrees. Scale in percent " +
                "(100 = unchanged). Mirror flags flip the corresponding axis. Only fields you " +
                "supply are changed."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id from list_placed_models"),
                "translate_x_mm" to Schemas.number("Absolute X translation, mm"),
                "translate_y_mm" to Schemas.number("Absolute Y translation, mm"),
                "translate_z_mm" to Schemas.number("Absolute Z translation, mm"),
                "rot_x_deg" to Schemas.number("X rotation, degrees"),
                "rot_y_deg" to Schemas.number("Y rotation, degrees"),
                "rot_z_deg" to Schemas.integer("Z rotation, degrees (integer)"),
                "scale_x_pct" to Schemas.number("X scale percent (100 = unchanged)"),
                "scale_y_pct" to Schemas.number("Y scale percent"),
                "scale_z_pct" to Schemas.number("Z scale percent"),
                "mirror_x" to Schemas.bool("Mirror across X"),
                "mirror_y" to Schemas.bool("Mirror across Y"),
                "mirror_z" to Schemas.bool("Mirror across Z"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val modelId = args.optString("model_id").trim()
            if (modelId.isEmpty()) return ToolResult.error("'model_id' is required.")
            val list = ws.placedModels.value
            if (list.none { it.id == modelId }) {
                return ToolResult.error("No model with id '$modelId'.")
            }
            ws.emit(
                WorkspaceAction.TransformModel(
                    modelId = modelId,
                    translateXmm = args.optFloat("translate_x_mm"),
                    translateYmm = args.optFloat("translate_y_mm"),
                    translateZmm = args.optFloat("translate_z_mm"),
                    rotXDeg = args.optFloat("rot_x_deg"),
                    rotYDeg = args.optFloat("rot_y_deg"),
                    rotZDeg = if (args.has("rot_z_deg")) args.optInt("rot_z_deg") else null,
                    scaleXPct = args.optFloat("scale_x_pct"),
                    scaleYPct = args.optFloat("scale_y_pct"),
                    scaleZPct = args.optFloat("scale_z_pct"),
                    mirrorX = if (args.has("mirror_x")) args.optBoolean("mirror_x") else null,
                    mirrorY = if (args.has("mirror_y")) args.optBoolean("mirror_y") else null,
                    mirrorZ = if (args.has("mirror_z")) args.optBoolean("mirror_z") else null,
                ),
            )
            return success("Transform applied to $modelId.", JSONObject().apply { put("model_id", modelId) })
        }
    }

    class DeleteModels(private val ws: WorkspaceModel) : Tool {
        override val name = "delete_models"
        override val description = "Remove the named models from the bed and clear them from the selection."
        override val inputSchema = Schemas.obj(
            required = listOf("model_ids"),
            properties = mapOf("model_ids" to Schemas.stringArray("Ids to delete (from list_placed_models)")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val rawIds = args.optJSONArray("model_ids") ?: JSONArray()
            val ids = (0 until rawIds.length()).map { rawIds.optString(it) }
                .filter { it.isNotBlank() }.toSet()
            if (ids.isEmpty()) return ToolResult.error("'model_ids' must be a non-empty array.")
            ws.emit(WorkspaceAction.DeleteModels(ids))
            return success("Deleted ${ids.size} model(s).", JSONObject().apply { put("deleted_count", ids.size) })
        }
    }

    // ---- Tier-B mutator tools ----

    class SliceActivePlate(private val ws: WorkspaceModel) : Tool {
        override val name = "slice_active_plate"
        override val description =
            "Trigger a slice of the models on the active plate. " +
                "Equivalent to tapping 'Slice' in the bottom-right summary panel. " +
                "Returns immediately; the slice runs asynchronously — poll get_workspace_state " +
                "(slice_state.kind=slicing→done) to follow progress. Multi-model plates are " +
                "sliced together with toolchange segmentation; single-model plates use the " +
                "fast nativeSlice path."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val placed = ws.placedModels.value.filter { it.plateId == ws.activePlateId.value }
            if (placed.isEmpty()) {
                return ToolResult.error(
                    "No models on the active plate (plate ${ws.activePlateId.value}). " +
                        "Add a model first.",
                )
            }
            ws.emit(WorkspaceAction.SliceActivePlate)
            return success(
                "Slice started for plate ${ws.activePlateId.value} (${placed.size} model(s)). " +
                    "Poll get_workspace_state to follow progress.",
                JSONObject().apply {
                    put("plate_id", ws.activePlateId.value)
                    put("model_count", placed.size)
                },
            )
        }
    }

    class CancelSlice(private val ws: WorkspaceModel) : Tool {
        override val name = "cancel_slice"
        override val description =
            "Request that the running slice cancel. NOTE: libslic3r doesn't expose an abort " +
                "hook through the JNI shim today, so this currently logs a warning and is a no-op. " +
                "Surface kept stable so client code doesn't break when the underlying capability " +
                "lands."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            ws.emit(WorkspaceAction.CancelSlice)
            return ToolResult.error(
                "cancel_slice is not yet supported — libslic3r doesn't expose an abort hook. " +
                    "The action was logged but no slice was cancelled.",
            )
        }
    }

    class AutoArrangePlate(private val ws: WorkspaceModel) : Tool {
        override val name = "auto_arrange_plate"
        override val description =
            "Run libslic3r's libnest2d-backed packer over the models on the active plate. " +
                "1 model → centers on bed origin. 2+ models → packs tightly within the printer's " +
                "bed bounds with 5 mm gaps. Updates each model's translateXmm/Ymm; rotation, " +
                "scale, and paint state are preserved."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val placed = ws.placedModels.value.filter { it.plateId == ws.activePlateId.value }
            if (placed.isEmpty()) return ToolResult.error("No models on the active plate.")
            ws.emit(WorkspaceAction.AutoArrangePlate)
            return success(
                "Auto-arrange started for ${placed.size} model(s) on plate ${ws.activePlateId.value}.",
                JSONObject().apply {
                    put("plate_id", ws.activePlateId.value)
                    put("model_count", placed.size)
                },
            )
        }
    }

    class DropToBed(private val ws: WorkspaceModel) : Tool {
        override val name = "drop_to_bed"
        override val description =
            "Snap a model's vertical translation back to z=0 so its lowest face sits on the bed. " +
                "Useful after rotation. The slicer's auto-bed-drop pass also runs at slice time, " +
                "but this gives the LLM a way to clean up the in-XR preview's floating Z."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf("model_id" to Schemas.string("Model id from list_placed_models")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val id = args.optString("model_id").trim()
            if (id.isEmpty()) return ToolResult.error("'model_id' is required.")
            if (ws.placedModels.value.none { it.id == id }) {
                return ToolResult.error("No model with id '$id'.")
            }
            ws.emit(WorkspaceAction.DropToBed(id))
            return success("Dropped $id to bed.", JSONObject().apply { put("model_id", id) })
        }
    }

    class SaveGcodeToDownloads(private val ws: WorkspaceModel) : Tool {
        override val name = "save_gcode_to_downloads"
        override val description =
            "Copy the most-recent successful slice's G-code into /Downloads, named after the " +
                "source. Requires slice_state.kind=done in get_workspace_state. " +
                "Requires All-Files-Access on Android (otherwise the host activity logs a permission failure)."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val ss = ws.sliceState.value
            if (ss !is SliceUiState.Done || ss.result !is dev.orcaxr.app.SliceResult.Success) {
                return ToolResult.error(
                    "No successful slice to save. " +
                        "Run slice_active_plate first and wait for slice_state.kind=done.",
                )
            }
            ws.emit(WorkspaceAction.SaveGcodeToDownloads)
            return success("Save G-code requested.", JSONObject().apply {
                put("source_label", ss.sourceLabel)
            })
        }
    }

    class SaveProjectAs3mf(private val ws: WorkspaceModel) : Tool {
        override val name = "save_project_as_3mf"
        override val description =
            "Save the currently-selected model + active config (profile, layer-height override, " +
                "Speed/Support overrides) + paint state as a 3MF project file in /Downloads. " +
                "Requires exactly one model selected; saves only that model's geometry + " +
                "paint metadata."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            if (ws.selectedModelIds.value.isEmpty()) {
                return ToolResult.error(
                    "No model selected. Use select_models with exactly one id, then retry.",
                )
            }
            ws.emit(WorkspaceAction.SaveProject3mf)
            return success(
                "Save 3MF requested for the selected model.",
                JSONObject().apply { put("selected_count", ws.selectedModelIds.value.size) },
            )
        }
    }

    class SaveModelAsStl(private val ws: WorkspaceModel) : Tool {
        override val name = "save_model_as_stl"
        override val description =
            "Save the currently-selected model as an STL into /Downloads. The mesh is " +
                "exported with current rotation, scale, and translation baked in. " +
                "Paint state is NOT preserved (STL has no material metadata) — use " +
                "save_project_as_3mf for that."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            if (ws.selectedModelIds.value.isEmpty()) {
                return ToolResult.error("No model selected.")
            }
            ws.emit(WorkspaceAction.SaveModelStl)
            return success(
                "Save STL requested for the selected model.",
                JSONObject().apply { put("selected_count", ws.selectedModelIds.value.size) },
            )
        }
    }
}

/** `org.json` doesn't have a Float helper; round-trip through Double. */
private fun JSONObject.optFloat(key: String): Float? =
    if (has(key) && !isNull(key)) optDouble(key, Double.NaN).takeIf { !it.isNaN() }?.toFloat() else null
