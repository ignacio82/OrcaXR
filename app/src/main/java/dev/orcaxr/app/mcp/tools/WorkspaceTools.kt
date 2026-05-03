package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.BedCollision
import dev.orcaxr.app.BedFit
import dev.orcaxr.app.EmbossAssets
import dev.orcaxr.app.GizmoTool
import dev.orcaxr.app.ModelVolumeType
import dev.orcaxr.app.PaintBrush
import dev.orcaxr.app.PaintMode
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.PlacedVolume
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
            LoadModelFromPath(workspace),
            SetPlateMovable(workspace),
            RepairModel(workspace),
            SimplifyModel(workspace),
            CutModel(workspace),
            MeshBoolean(workspace),
            SplitModel(workspace),
            ListEmbossFonts(),
            EmbossModel(workspace),
            ListVolumes(workspace),
            AddVolumeToModel(workspace),
            RemoveVolume(workspace),
            // A10 — adaptive / variable layer height
            ComputeAdaptiveLayerHeights(workspace),
            GetLayerHeightProfile(workspace),
            SetLayerHeightProfile(workspace),
            ClearLayerHeightProfile(workspace),
            // D16 — per-volume Object Settings
            GetVolumeOverrides(workspace),
            SetVolumeOverrides(workspace),
            GetPaintSummary(workspace),
            ClearPaint(workspace),
            ReplacePaintTag(workspace),
            PaintSplitPlane(workspace),
            PaintUndo(workspace),
            PaintRedo(workspace),
            FlushActions(workspace),
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
        // A10 — surface presence + entry count of the per-object
        // layer-height profile. Full waypoints are available via
        // get_layer_height_profile to keep this summary cheap.
        val lhp = m.layerHeightProfile
        if (lhp != null && lhp.size >= 4 && (lhp.size and 1) == 0) {
            put("layer_height_profile_entry_count", lhp.size / 2)
            put("layer_height_profile_z_min_mm", lhp[0])
            put("layer_height_profile_z_max_mm", lhp[lhp.size - 2])
        }
        // D16 — surface volumes with overrides so the LLM can
        // discover where to call get_volume_overrides without a
        // separate list_volumes round trip on every model.
        if (m.volumes.isNotEmpty()) {
            val vols = JSONArray()
            for (v in m.volumes) {
                vols.put(JSONObject().apply {
                    put("id", v.id)
                    put("type", v.type.name)
                    put("override_count", v.configOverrides.size)
                })
            }
            put("volumes", vols)
        }
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
            state.put("plate_movable", ws.plateMovable.value)

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

    class LoadModelFromPath(private val ws: WorkspaceModel) : Tool {
        override val name = "load_model_from_path"
        override val description =
            "Load a model file (STL / 3MF / OBJ / AMF) from a filesystem path. " +
                "Mode 'replace' (default) clears the current bed and drops in the new model; " +
                "mode 'add' appends a new placed model alongside existing ones. " +
                "The file must already be readable on-device — typical paths are " +
                "/sdcard/Download/<file> or anything from list_recent_files. After this " +
                "completes, the GLB preview, paint restore, bed-fit and bed-collision checks " +
                "all run automatically — get_workspace_state will reflect the new state."
        override val inputSchema = Schemas.obj(
            required = listOf("path"),
            properties = mapOf(
                "path" to Schemas.string("Absolute filesystem path to a model file"),
                "mode" to Schemas.string("'replace' (default) or 'add'"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val rawPath = args.optString("path").trim()
            if (rawPath.isEmpty()) return ToolResult.error("'path' is required.")
            val file = java.io.File(rawPath)
            if (!file.exists()) return ToolResult.error("File not found: $rawPath")
            if (!file.canRead()) return ToolResult.error("File exists but is unreadable: $rawPath. Check All-Files-Access.")
            val ext = file.extension.lowercase()
            val supported = setOf("stl", "3mf", "obj", "amf", "step", "stp")
            if (ext !in supported) {
                return ToolResult.error(
                    "Unsupported extension '.$ext'. Supported: ${supported.joinToString()}",
                )
            }
            val mode = when (args.optString("mode", "replace").lowercase()) {
                "replace", "" -> WorkspaceAction.LoadMode.Replace
                "add", "append" -> WorkspaceAction.LoadMode.Add
                else -> return ToolResult.error("Mode must be 'replace' or 'add'.")
            }
            ws.emit(WorkspaceAction.LoadModelFromPath(file.absolutePath, mode))
            return success(
                "Loading ${file.name} (mode=${mode.name.lowercase()}). " +
                    "Poll get_workspace_state to confirm it's on the bed.",
                JSONObject().apply {
                    put("path", file.absolutePath)
                    put("mode", mode.name.lowercase())
                    put("size_bytes", file.length())
                },
            )
        }
    }

    class SetPlateMovable(private val ws: WorkspaceModel) : Tool {
        override val name = "set_plate_movable"
        override val description =
            "Toggle the workspace-grab affordance. true = the bed becomes a single grab " +
                "target (pinching anywhere over it drags the build plate in 3D space). " +
                "false = pinches go through to the model gizmos. Default is false."
        override val inputSchema = Schemas.obj(
            required = listOf("movable"),
            properties = mapOf("movable" to Schemas.bool("true to enable bed-grab; false to disable")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val v = args.optBoolean("movable", false)
            ws.emit(WorkspaceAction.SetPlateMovable(v))
            return success(
                "plate_movable = $v",
                JSONObject().apply { put("plate_movable", v) },
            )
        }
    }

    // ---- Model-editing tools (repair / cut / boolean / split) ----

    class RepairModel(private val ws: WorkspaceModel) : Tool {
        override val name = "repair_model"
        override val description =
            "Run libslic3r's mesh-repair pass on a model (`MeshBoolean::self_union` + " +
                "ADMesh degenerate-face cleanup). Replaces the model's source with the repaired " +
                "mesh. Paint state is dropped — per-triangle indices don't survive a re-mesh, " +
                "and bleeding paint into the wrong faces would be worse than starting fresh."
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
            ws.emit(WorkspaceAction.RepairModel(id))
            return success("Repair started for $id.", JSONObject().apply { put("model_id", id) })
        }
    }

    class SimplifyModel(private val ws: WorkspaceModel) : Tool {
        override val name = "simplify_model"
        override val description =
            "D17 — Run libslic3r's quadric edge collapse to reduce a model's triangle count " +
                "(`its_quadric_edge_collapse` — Garland-Heckbert metric). Replaces the model's " +
                "source with the simplified mesh. target_triangle_count is the desired post-" +
                "simplify tri count; libslic3r usually overshoots by a few when no further " +
                "edges meet the max_error budget. Heavy meshes (1M+ tris) thrash the paint BVH " +
                "and toolpath debounce — simplifying to ~200K triangles before authoring is the " +
                "intended workflow. Paint state is dropped (per-triangle indices don't survive " +
                "the re-mesh; same convention as repair_model). max_error is the per-collapse " +
                "Garland-Heckbert error cap; pass a small value (≤ 0.01) to preserve sharp " +
                "features, larger (≥ 1.0) to collapse aggressively, or 0 to disable the cap."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "target_triangle_count"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id from list_placed_models"),
                "target_triangle_count" to Schemas.integer(
                    "Desired post-simplify triangle count (must be > 4 and < input tri count)",
                ),
                "max_error" to Schemas.number(
                    "Per-collapse Garland-Heckbert error cap (default 0 = no cap)",
                ),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val id = args.optString("model_id").trim()
            if (id.isEmpty()) return ToolResult.error("'model_id' is required.")
            if (ws.placedModels.value.none { it.id == id }) {
                return ToolResult.error("No model with id '$id'.")
            }
            val target = args.optInt("target_triangle_count", -1)
            if (target <= 4) {
                return ToolResult.error(
                    "target_triangle_count must be > 4 (got $target).",
                )
            }
            val maxError = args.optDouble("max_error", 0.0).toFloat()
            ws.emit(WorkspaceAction.SimplifyModel(id, target, maxError))
            return success(
                "Simplify started for $id (target $target tris).",
                JSONObject().apply {
                    put("model_id", id)
                    put("target_triangle_count", target)
                    put("max_error", maxError.toDouble())
                },
            )
        }
    }

    class CutModel(private val ws: WorkspaceModel) : Tool {
        override val name = "cut_model"
        override val description =
            "Cut a model with a horizontal plane at z = plane_z_mm (in printer-frame mm above " +
                "the bed). Replaces the model with the cut output (a single 3MF containing both " +
                "halves; libslic3r's auto-bed-drop handles re-grounding the lower half at slice " +
                "time). To cut at, e.g., the midpoint, pass plane_z_mm equal to half the model's " +
                "base_bbox_z_mm."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "plane_z_mm"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id from list_placed_models"),
                "plane_z_mm" to Schemas.number("Cut plane height above the bed, in mm"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val id = args.optString("model_id").trim()
            if (id.isEmpty()) return ToolResult.error("'model_id' is required.")
            if (!args.has("plane_z_mm")) return ToolResult.error("'plane_z_mm' is required.")
            val plane = args.getDouble("plane_z_mm").toFloat()
            if (!plane.isFinite() || plane <= 0f) {
                return ToolResult.error("'plane_z_mm' must be a positive finite number.")
            }
            if (ws.placedModels.value.none { it.id == id }) {
                return ToolResult.error("No model with id '$id'.")
            }
            ws.emit(WorkspaceAction.CutModel(id, plane))
            return success(
                "Cut started for $id at z=${plane}mm.",
                JSONObject().apply {
                    put("model_id", id)
                    put("plane_z_mm", plane)
                },
            )
        }
    }

    class MeshBoolean(private val ws: WorkspaceModel) : Tool {
        override val name = "mesh_boolean"
        override val description =
            "Compute a boolean op between two models. op='union' merges, op='difference' " +
                "subtracts B from A, op='intersection' keeps only the overlap. Result " +
                "replaces model A; model B is unchanged."
        override val inputSchema = Schemas.obj(
            required = listOf("model_a_id", "model_b_id", "op"),
            properties = mapOf(
                "model_a_id" to Schemas.string("First operand model id"),
                "model_b_id" to Schemas.string("Second operand model id"),
                "op" to Schemas.string("'union', 'difference', or 'intersection'"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val a = args.optString("model_a_id").trim()
            val b = args.optString("model_b_id").trim()
            if (a.isEmpty() || b.isEmpty()) {
                return ToolResult.error("Both 'model_a_id' and 'model_b_id' are required.")
            }
            if (a == b) return ToolResult.error("model_a_id and model_b_id must differ.")
            val present = ws.placedModels.value.map { it.id }.toSet()
            if (a !in present || b !in present) {
                return ToolResult.error("One or both ids don't match a placed model.")
            }
            val opCode = when (args.optString("op").lowercase()) {
                "union", "u", "0" -> 0
                "difference", "diff", "subtract", "minus", "1" -> 1
                "intersection", "intersect", "and", "2" -> 2
                else -> return ToolResult.error("Unknown op. Use 'union' | 'difference' | 'intersection'.")
            }
            ws.emit(WorkspaceAction.MeshBoolean(a, b, opCode))
            return success(
                "Boolean ${args.optString("op")} started.",
                JSONObject().apply {
                    put("model_a_id", a)
                    put("model_b_id", b)
                    put("op_code", opCode)
                },
            )
        }
    }

    class SplitModel(private val ws: WorkspaceModel) : Tool {
        override val name = "split_model"
        override val description =
            "Split a model into its disconnected components (each connected mesh becomes " +
                "its own PlacedModel on the bed). No-op if the mesh is already a single " +
                "connected component."
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
            ws.emit(WorkspaceAction.SplitModel(id))
            return success("Split started for $id.", JSONObject().apply { put("model_id", id) })
        }
    }

    // ---- Embossing tools ----

    class ListEmbossFonts : Tool {
        override val name = "list_emboss_fonts"
        override val description =
            "List the bundled fonts available for emboss_model's text variant. Each font has " +
                "an `id` (pass to emboss_model) and a `display_name`. Users can also pick their " +
                "own .ttf via Android's storage picker, but that path isn't yet exposed via MCP."
        override val inputSchema = Schemas.empty()
        override suspend fun call(args: JSONObject): ToolResult {
            val arr = JSONArray()
            for (f in EmbossAssets.BUNDLED_FONTS) {
                val obj = JSONObject()
                obj.put("id", f.id)
                obj.put("display_name", f.displayName)
                arr.put(obj)
            }
            val body = JSONObject().apply {
                put("ok", true)
                put("count", EmbossAssets.BUNDLED_FONTS.size)
                put("default_font_id", EmbossAssets.DEFAULT_FONT.id)
                put("fonts", arr)
            }
            val text = EmbossAssets.BUNDLED_FONTS.joinToString("\n") { "- ${it.id}  ${it.displayName}" }
            return ToolResult.ok(text, body)
        }
    }

    class EmbossModel(private val ws: WorkspaceModel) : Tool {
        override val name = "emboss_model"
        override val description =
            "Apply embossed text or an SVG inset to a model's top face — OR (D15) author " +
                "standalone text/SVG as a fresh PlacedModel with no host. " +
                "kind='text' takes `text` + optional `font_id` (defaults to dejavu_sans_bold). " +
                "kind='svg' takes `svg_path` (absolute path to a .svg with filled paths). " +
                "size_mm is line height (text) or max XY (svg); depth_mm is Z extrusion. " +
                "mode='emboss' raises letters above the host (boolean union); mode='engrave' " +
                "carves them in (A−B); mode='add_object' (D15) skips the boolean and drops the " +
                "extruded mesh on the bed as a new PlacedModel — useful for nameplates, signage, " +
                "labels, or generating a part from an SVG silhouette without a host. " +
                "model_id is REQUIRED for emboss/engrave, OPTIONAL (and ignored) for add_object. " +
                "Optional translate_x_mm / translate_y_mm / rot_z_deg offset the emboss before " +
                "the boolean (emboss/engrave only; add_object lands on the bed at origin). " +
                "load_mode='add' (default) keeps existing models on the bed; 'replace' clears."
        override val inputSchema = Schemas.obj(
            required = listOf("kind", "size_mm", "depth_mm"),
            properties = mapOf(
                "model_id" to Schemas.string("Host model id (required for emboss/engrave; ignored for add_object)"),
                "kind" to Schemas.string("'text' or 'svg'"),
                "text" to Schemas.string("(text only) the string to emboss"),
                "font_id" to Schemas.string("(text only) bundled font id from list_emboss_fonts"),
                "svg_path" to Schemas.string("(svg only) absolute path to a .svg file"),
                "size_mm" to Schemas.number("Line height (text) or max XY (svg) in mm"),
                "depth_mm" to Schemas.number("Z extrusion depth in mm"),
                "mode" to Schemas.string("'emboss' (raise) | 'engrave' (carve) | 'add_object' (D15: standalone)"),
                "translate_x_mm" to Schemas.number("Optional X offset on the host's top face"),
                "translate_y_mm" to Schemas.number("Optional Y offset"),
                "rot_z_deg" to Schemas.number("Optional Z rotation in degrees"),
                "load_mode" to Schemas.string("(add_object only) 'add' (default) or 'replace'"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val modeRaw = args.optString("mode", "emboss").lowercase()
            val isAddObject = modeRaw in setOf("add_object", "object", "standalone")
            val modelId = args.optString("model_id").trim()
            if (!isAddObject) {
                if (modelId.isEmpty()) return ToolResult.error("'model_id' is required for emboss/engrave.")
                if (ws.placedModels.value.none { it.id == modelId }) {
                    return ToolResult.error("No model with id '$modelId'.")
                }
            }
            val kind = args.optString("kind").lowercase()
            val sizeMm = args.optDouble("size_mm", 0.0).toFloat()
            val depthMm = args.optDouble("depth_mm", 0.0).toFloat()
            if (sizeMm <= 0f) return ToolResult.error("'size_mm' must be > 0.")
            if (depthMm <= 0f) return ToolResult.error("'depth_mm' must be > 0.")
            val source: WorkspaceAction.EmbossSource = when (kind) {
                "text" -> {
                    val text = args.optString("text", "").trim()
                    if (text.isEmpty()) return ToolResult.error("'text' is required when kind='text'.")
                    val fontId = args.optString("font_id").ifBlank { EmbossAssets.DEFAULT_FONT.id }
                    if (EmbossAssets.BUNDLED_FONTS.none { it.id == fontId }) {
                        return ToolResult.error(
                            "Unknown font_id '$fontId'. Use list_emboss_fonts.",
                        )
                    }
                    WorkspaceAction.EmbossSource.Text(text, fontId)
                }
                "svg" -> {
                    val path = args.optString("svg_path").trim()
                    if (path.isEmpty()) return ToolResult.error("'svg_path' is required when kind='svg'.")
                    val f = java.io.File(path)
                    if (!f.exists() || !f.canRead()) {
                        return ToolResult.error("SVG file not readable: $path")
                    }
                    WorkspaceAction.EmbossSource.Svg(f.absolutePath)
                }
                else -> return ToolResult.error("'kind' must be 'text' or 'svg'.")
            }
            if (isAddObject) {
                val loadMode = when (args.optString("load_mode", "add").lowercase()) {
                    "add", "" -> WorkspaceAction.LoadMode.Add
                    "replace" -> WorkspaceAction.LoadMode.Replace
                    else -> return ToolResult.error("'load_mode' must be 'add' or 'replace'.")
                }
                ws.emit(
                    WorkspaceAction.AddTextOrSvgObject(
                        source = source,
                        sizeMm = sizeMm,
                        depthMm = depthMm,
                        loadMode = loadMode,
                    ),
                )
                return success(
                    "Add-object started (kind=$kind).",
                    JSONObject().apply {
                        put("kind", kind); put("mode", "add_object")
                        put("size_mm", sizeMm); put("depth_mm", depthMm)
                        put("load_mode", loadMode.name.lowercase())
                    },
                )
            }
            val mode = when (modeRaw) {
                "emboss", "add", "raise", "" -> WorkspaceAction.EmbossMode.Add
                "engrave", "sub", "carve", "subtract" -> WorkspaceAction.EmbossMode.Sub
                else -> return ToolResult.error("'mode' must be 'emboss', 'engrave', or 'add_object'.")
            }
            ws.emit(
                WorkspaceAction.EmbossModel(
                    modelId = modelId,
                    source = source,
                    sizeMm = sizeMm,
                    depthMm = depthMm,
                    mode = mode,
                    translateXmm = args.optDouble("translate_x_mm", 0.0).toFloat(),
                    translateYmm = args.optDouble("translate_y_mm", 0.0).toFloat(),
                    rotZDeg = args.optDouble("rot_z_deg", 0.0).toFloat(),
                ),
            )
            return success(
                "Emboss started on $modelId.",
                JSONObject().apply {
                    put("model_id", modelId)
                    put("kind", kind)
                    put("mode", mode.name.lowercase())
                    put("size_mm", sizeMm)
                    put("depth_mm", depthMm)
                },
            )
        }
    }

    // ---- Per-volume editing tools ----

    class ListVolumes(private val ws: WorkspaceModel) : Tool {
        override val name = "list_volumes"
        override val description =
            "List the modifier / negative / support volumes attached to a model. The model's " +
                "primary mesh (`model.source`) is always implicit and not in this list — only " +
                "extra volumes added via add_volume_to_model show up here."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf("model_id" to Schemas.string("Model id from list_placed_models")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optString("model_id").trim()
            val model = ws.placedModels.value.firstOrNull { it.id == id }
                ?: return ToolResult.error("No model with id '$id'.")
            val arr = JSONArray()
            for (v in model.volumes) arr.put(encodeVolume(v))
            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", id)
                put("count", model.volumes.size)
                put("volumes", arr)
            }
            val text = if (model.volumes.isEmpty()) "(no extra volumes)"
                else model.volumes.joinToString("\n") { v ->
                    "- ${v.type.name}  ${v.source.name}  id=${v.id}"
                }
            return ToolResult.ok(text, body)
        }
    }

    class AddVolumeToModel(private val ws: WorkspaceModel) : Tool {
        override val name = "add_volume_to_model"
        override val description =
            "Append a volume from a file (STL/3MF/OBJ) to an existing model. type is one of: " +
                "MODEL_PART (extra geometry, prints as part of the same object), NEGATIVE_VOLUME " +
                "(carve away), PARAMETER_MODIFIER (per-region setting overrides), " +
                "SUPPORT_ENFORCER (force supports), SUPPORT_BLOCKER (forbid supports). " +
                "Routes through the same PickerMode.AddVolume codepath the file picker uses, so " +
                "the colored-GLB rebuild and paint propagation match the manual flow."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "source_path", "type"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id to attach the volume to"),
                "source_path" to Schemas.string("Absolute path to a mesh file"),
                "type" to Schemas.string(
                    "MODEL_PART | NEGATIVE_VOLUME | PARAMETER_MODIFIER | SUPPORT_BLOCKER | SUPPORT_ENFORCER",
                ),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val modelId = args.optString("model_id").trim()
            if (modelId.isEmpty()) return ToolResult.error("'model_id' is required.")
            if (ws.placedModels.value.none { it.id == modelId }) {
                return ToolResult.error("No model with id '$modelId'.")
            }
            val sourcePath = args.optString("source_path").trim()
            if (sourcePath.isEmpty()) return ToolResult.error("'source_path' is required.")
            val file = java.io.File(sourcePath)
            if (!file.exists()) return ToolResult.error("File not found: $sourcePath")
            if (!file.canRead()) return ToolResult.error("File unreadable: $sourcePath")
            val typeName = args.optString("type").trim()
            val type = runCatching { ModelVolumeType.valueOf(typeName) }.getOrNull()
                ?: return ToolResult.error(
                    "Unknown type '$typeName'. Use one of: ${ModelVolumeType.values().joinToString { it.name }}",
                )
            ws.emit(WorkspaceAction.AddVolumeToModel(modelId, file.absolutePath, type.name))
            return success(
                "Adding ${type.name} volume from ${file.name} to $modelId.",
                JSONObject().apply {
                    put("model_id", modelId)
                    put("source_path", file.absolutePath)
                    put("type", type.name)
                },
            )
        }
    }

    class RemoveVolume(private val ws: WorkspaceModel) : Tool {
        override val name = "remove_volume"
        override val description =
            "Remove a previously-attached volume from a model. Use list_volumes to find " +
                "the volume id."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "volume_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "volume_id" to Schemas.string("Volume id from list_volumes"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val modelId = args.optString("model_id").trim()
            val volumeId = args.optString("volume_id").trim()
            if (modelId.isEmpty() || volumeId.isEmpty()) {
                return ToolResult.error("Both 'model_id' and 'volume_id' are required.")
            }
            val model = ws.placedModels.value.firstOrNull { it.id == modelId }
                ?: return ToolResult.error("No model with id '$modelId'.")
            if (model.volumes.none { it.id == volumeId }) {
                return ToolResult.error("No volume with id '$volumeId' on model '$modelId'.")
            }
            ws.emit(WorkspaceAction.RemoveVolume(modelId, volumeId))
            return success(
                "Removed volume $volumeId from $modelId.",
                JSONObject().apply {
                    put("model_id", modelId)
                    put("volume_id", volumeId)
                },
            )
        }
    }

    // ---- A10 — Adaptive / variable layer-height tools ----

    /**
     * A10 — emit a [WorkspaceAction.ComputeAdaptiveLayerHeights] for a
     * single model. MainActivity's handler computes the profile via
     * `SlicerEngine.computeAdaptiveLayerHeights` and writes it onto
     * `PlacedModel.layerHeightProfile`. The next slice picks it up
     * automatically.
     */
    class ComputeAdaptiveLayerHeights(private val ws: WorkspaceModel) : Tool {
        override val name = "compute_adaptive_layer_heights"
        override val description =
            "A10 — auto-compute an adaptive variable-layer-height profile for a model via " +
                "libslic3r's `layer_height_profile_adaptive` + optional `smooth_height_profile`. " +
                "Stores the profile on `PlacedModel.layerHeightProfile`; the next slice " +
                "applies it automatically. quality is 0..1 (higher = finer over curved " +
                "surfaces). smoothing_radius is 0..10 (0 = no smoothing). The model's " +
                "min/max layer-height bounds come from the active profile + " +
                "layer_height_override (so picking a finer profile produces a finer adaptive " +
                "profile). Use clear_layer_height_profile to revert."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id from list_placed_models"),
                "quality" to Schemas.number("0..1, default 0.5 — higher = finer over curves"),
                "smoothing_radius" to Schemas.integer(
                    "0..10, default 0 — Gaussian blur radius applied to the profile",
                ),
                "smoothing_keep_min" to Schemas.bool(
                    "When true, preserve min-h spikes through smoothing (default false)",
                ),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val id = args.optString("model_id").trim()
            if (id.isEmpty()) return ToolResult.error("'model_id' is required.")
            if (ws.placedModels.value.none { it.id == id }) {
                return ToolResult.error("No model with id '$id'.")
            }
            val q = args.optDouble("quality", 0.5).toFloat()
            if (!q.isFinite() || q < 0f || q > 1f) {
                return ToolResult.error("'quality' must be in [0, 1] (got $q).")
            }
            val sr = args.optInt("smoothing_radius", 0)
            if (sr < 0 || sr > 10) {
                return ToolResult.error("'smoothing_radius' must be in [0, 10] (got $sr).")
            }
            val keepMin = args.optBoolean("smoothing_keep_min", false)
            ws.emit(
                WorkspaceAction.ComputeAdaptiveLayerHeights(
                    modelId = id,
                    quality = q,
                    smoothingRadius = sr,
                    smoothingKeepMin = keepMin,
                ),
            )
            return success(
                "Computing adaptive layer heights for $id (quality=$q, smoothing=$sr).",
                JSONObject().apply {
                    put("model_id", id)
                    put("quality", q.toDouble())
                    put("smoothing_radius", sr)
                    put("smoothing_keep_min", keepMin)
                },
            )
        }
    }

    /**
     * A10 — read the stored layer-height profile for a model. Returns
     * `[]` if the model has no profile (uses the global layer_height
     * for every layer).
     */
    class GetLayerHeightProfile(private val ws: WorkspaceModel) : Tool {
        override val name = "get_layer_height_profile"
        override val description =
            "Read the stored adaptive / variable layer-height profile for a model as a list " +
                "of {z_mm, h_mm} entries. Empty list = no per-object override; libslic3r's " +
                "global layer_height applies to every layer."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf("model_id" to Schemas.string("Model id from list_placed_models")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val id = args.optString("model_id").trim()
            if (id.isEmpty()) return ToolResult.error("'model_id' is required.")
            val model = ws.placedModels.value.firstOrNull { it.id == id }
                ?: return ToolResult.error("No model with id '$id'.")
            val arr = model.layerHeightProfile
            val pairs = JSONArray()
            if (arr != null && arr.size >= 4 && (arr.size and 1) == 0) {
                var i = 0
                while (i < arr.size) {
                    pairs.put(JSONObject().apply {
                        put("z_mm", arr[i].toDouble())
                        put("h_mm", arr[i + 1].toDouble())
                    })
                    i += 2
                }
            }
            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", id)
                put("entry_count", pairs.length())
                put("profile", pairs)
            }
            return ToolResult.ok(
                if (pairs.length() == 0) "$id has no layer-height profile."
                else "$id has ${pairs.length()} (z, h) entries.",
                body,
            )
        }
    }

    /**
     * A10 — write a hand-built profile onto a model. The MCP caller
     * passes a JSON array of {z_mm, h_mm} objects (or a flat alternating
     * array of numbers). Empty / missing array clears the profile.
     */
    class SetLayerHeightProfile(private val ws: WorkspaceModel) : Tool {
        override val name = "set_layer_height_profile"
        override val description =
            "Write a hand-built variable-layer-height profile onto a model. profile is a " +
                "JSON array of {z_mm, h_mm} objects in monotonically-increasing Z. Empty / " +
                "missing array clears any existing profile (model reverts to the global " +
                "layer_height). Use compute_adaptive_layer_heights for the auto-compute path."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id from list_placed_models"),
                "profile" to JSONObject().apply {
                    put("type", "array")
                    put("description", "[{z_mm: float, h_mm: float}, ...] — empty / missing = clear")
                    put("items", JSONObject().apply {
                        put("type", "object")
                        put("properties", JSONObject().apply {
                            put("z_mm", Schemas.number("Print Z in mm"))
                            put("h_mm", Schemas.number("Layer thickness at this Z, in mm"))
                        })
                        put("required", JSONArray().apply { put("z_mm"); put("h_mm") })
                    })
                },
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val id = args.optString("model_id").trim()
            if (id.isEmpty()) return ToolResult.error("'model_id' is required.")
            if (ws.placedModels.value.none { it.id == id }) {
                return ToolResult.error("No model with id '$id'.")
            }
            val raw = args.optJSONArray("profile")
            val profile: FloatArray? = if (raw == null || raw.length() == 0) {
                null
            } else {
                val out = ArrayList<Float>(raw.length() * 2)
                for (i in 0 until raw.length()) {
                    val entry = raw.optJSONObject(i)
                        ?: return ToolResult.error("'profile[$i]' must be {z_mm, h_mm}.")
                    val z = entry.optDouble("z_mm", Double.NaN)
                    val h = entry.optDouble("h_mm", Double.NaN)
                    if (z.isNaN() || h.isNaN()) {
                        return ToolResult.error("'profile[$i]' missing z_mm or h_mm.")
                    }
                    if (h <= 0) {
                        return ToolResult.error("'profile[$i].h_mm' must be > 0 (got $h).")
                    }
                    out += z.toFloat()
                    out += h.toFloat()
                }
                if (out.size < 4) {
                    return ToolResult.error(
                        "Profile must have ≥ 2 entries (4 floats). Got ${out.size / 2}.",
                    )
                }
                // Monotonic-Z check.
                var prev = Float.NEGATIVE_INFINITY
                var i = 0
                while (i < out.size) {
                    if (out[i] < prev) {
                        return ToolResult.error(
                            "z_mm must be monotonically non-decreasing " +
                                "(profile[${i / 2}].z_mm = ${out[i]} < ${prev}).",
                        )
                    }
                    prev = out[i]
                    i += 2
                }
                out.toFloatArray()
            }
            ws.emit(WorkspaceAction.SetLayerHeightProfile(id, profile))
            return success(
                if (profile == null) "Cleared layer-height profile on $id."
                else "Wrote ${profile.size / 2} (z, h) entries to $id.",
                JSONObject().apply {
                    put("model_id", id)
                    put("entry_count", (profile?.size ?: 0) / 2)
                    put("cleared", profile == null)
                },
            )
        }
    }

    /**
     * A10 — clear a model's layer-height profile so the global
     * layer_height applies to every layer. Convenience wrapper around
     * [SetLayerHeightProfile] with a null profile so the LLM doesn't
     * need to know the JSON shape just to revert.
     */
    class ClearLayerHeightProfile(private val ws: WorkspaceModel) : Tool {
        override val name = "clear_layer_height_profile"
        override val description =
            "Clear a model's variable layer-height profile so libslic3r's global " +
                "layer_height applies to every layer. No-op if the model has no profile."
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
            ws.emit(WorkspaceAction.SetLayerHeightProfile(id, null))
            return success(
                "Cleared layer-height profile on $id.",
                JSONObject().apply {
                    put("model_id", id)
                    put("cleared", true)
                },
            )
        }
    }

    // ---- D16 — per-volume Object Settings tools ----

    /**
     * D16 — read the per-volume `configOverrides` map. Empty `{}` means
     * the volume uses the parent ModelObject's / global config for
     * every key (the default).
     */
    class GetVolumeOverrides(private val ws: WorkspaceModel) : Tool {
        override val name = "get_volume_overrides"
        override val description =
            "D16 — read the per-volume config overrides for one PlacedVolume. Returns " +
                "a string→string map keyed by libslic3r config key. Empty map = no overrides " +
                "(the volume inherits the parent ModelObject's / global config). Use " +
                "list_volumes to discover volume ids."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "volume_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "volume_id" to Schemas.string("Volume id from list_volumes"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val modelId = args.optString("model_id").trim()
            val volumeId = args.optString("volume_id").trim()
            if (modelId.isEmpty() || volumeId.isEmpty()) {
                return ToolResult.error("Both 'model_id' and 'volume_id' are required.")
            }
            val model = ws.placedModels.value.firstOrNull { it.id == modelId }
                ?: return ToolResult.error("No model with id '$modelId'.")
            val volume = model.volumes.firstOrNull { it.id == volumeId }
                ?: return ToolResult.error("No volume with id '$volumeId' on model '$modelId'.")
            val overrides = JSONObject()
            for ((k, v) in volume.configOverrides) overrides.put(k, v)
            return ToolResult.ok(
                if (volume.configOverrides.isEmpty())
                    "Volume $volumeId has no overrides (inherits parent)."
                else "Volume $volumeId has ${volume.configOverrides.size} override(s).",
                JSONObject().apply {
                    put("ok", true)
                    put("model_id", modelId)
                    put("volume_id", volumeId)
                    put("type", volume.type.name)
                    put("override_count", volume.configOverrides.size)
                    put("overrides", overrides)
                },
            )
        }
    }

    /**
     * D16 — replace a volume's `configOverrides` map. The handler
     * REPLACES the existing map (so a partial update has to read first
     * via [GetVolumeOverrides], then merge client-side, then write).
     * Empty `{}` clears all overrides.
     *
     * Per-volume overrides are most useful on PARAMETER_MODIFIER
     * volumes (e.g. denser infill in a band of the model). libslic3r
     * accepts overrides on any volume type; SUPPORT_ENFORCER /
     * SUPPORT_BLOCKER mostly read `support_*` keys, MODEL_PART /
     * NEGATIVE_VOLUME mostly read perimeter/infill keys.
     */
    class SetVolumeOverrides(private val ws: WorkspaceModel) : Tool {
        override val name = "set_volume_overrides"
        override val description =
            "D16 — write a string→string map of libslic3r config overrides onto a single " +
                "PlacedVolume. REPLACES the existing map (read with get_volume_overrides + " +
                "merge client-side for partial updates). Pass {} to clear. Most useful on " +
                "PARAMETER_MODIFIER volumes (e.g. {\"sparse_infill_density\": \"100\"} on a " +
                "band of the model). Keys flow through libslic3r's `set_deserialize` so any " +
                "DynamicPrintConfig key is acceptable; unknown keys are silently dropped at " +
                "slice time with a JNI log line."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "volume_id", "overrides"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "volume_id" to Schemas.string("Volume id from list_volumes"),
                "overrides" to JSONObject().apply {
                    put("type", "object")
                    put("description", "String→string map of libslic3r config keys → values. {} clears.")
                    put("additionalProperties", JSONObject().apply { put("type", "string") })
                },
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val modelId = args.optString("model_id").trim()
            val volumeId = args.optString("volume_id").trim()
            if (modelId.isEmpty() || volumeId.isEmpty()) {
                return ToolResult.error("Both 'model_id' and 'volume_id' are required.")
            }
            val model = ws.placedModels.value.firstOrNull { it.id == modelId }
                ?: return ToolResult.error("No model with id '$modelId'.")
            val volume = model.volumes.firstOrNull { it.id == volumeId }
                ?: return ToolResult.error("No volume with id '$volumeId' on model '$modelId'.")
            val raw = args.optJSONObject("overrides")
                ?: return ToolResult.error("'overrides' must be an object (use {} to clear).")
            val out = LinkedHashMap<String, String>()
            val it = raw.keys()
            while (it.hasNext()) {
                val k = it.next()
                val v = raw.opt(k)
                if (v == null) continue
                // Coerce numbers / bools to their wire-format string.
                // libslic3r's set_deserialize parses strings.
                val sv = when (v) {
                    is String -> v
                    is Boolean -> if (v) "1" else "0"
                    is Int, is Long -> v.toString()
                    is Double, is Float -> v.toString()
                    else -> v.toString()
                }
                if (k.isBlank()) continue
                out[k] = sv
            }
            ws.emit(WorkspaceAction.SetVolumeOverrides(modelId, volumeId, out))
            return success(
                if (out.isEmpty()) "Cleared overrides on volume $volumeId of $modelId."
                else "Wrote ${out.size} override(s) on volume $volumeId of $modelId.",
                JSONObject().apply {
                    put("model_id", modelId)
                    put("volume_id", volumeId)
                    put("type", volume.type.name)
                    put("override_count", out.size)
                },
            )
        }
    }

    // ---- Paint-by-API tools ----

    /** Parse "color"/"support"/"seam"/"fuzzy"/"fuzzy_skin" into the
     *  matching PaintKind enum, or null on unknown input. */
    private fun parsePaintKind(raw: String): WorkspaceAction.PaintKind? = when (raw.lowercase()) {
        "color", "filament", "" -> WorkspaceAction.PaintKind.Color
        "support" -> WorkspaceAction.PaintKind.Support
        "seam" -> WorkspaceAction.PaintKind.Seam
        "fuzzy", "fuzzy_skin", "fuzzyskin" -> WorkspaceAction.PaintKind.FuzzySkin
        else -> null
    }

    private fun arrayFor(m: PlacedModel, kind: WorkspaceAction.PaintKind): ByteArray? = when (kind) {
        WorkspaceAction.PaintKind.Color -> m.paintFilamentIndex
        WorkspaceAction.PaintKind.Support -> m.supportFlags
        WorkspaceAction.PaintKind.Seam -> m.seamFlags
        WorkspaceAction.PaintKind.FuzzySkin -> m.fuzzySkinFlags
    }

    /** Histogram of tag → triangle count for one paint kind. */
    private fun histogram(arr: ByteArray?): Map<Int, Int> {
        if (arr == null) return emptyMap()
        val out = HashMap<Int, Int>()
        for (b in arr) {
            val k = b.toInt() and 0xff
            out[k] = (out[k] ?: 0) + 1
        }
        return out
    }

    class GetPaintSummary(private val ws: WorkspaceModel) : Tool {
        override val name = "get_paint_summary"
        override val description =
            "Per-tag triangle histogram for a model's paint state. Use this BEFORE replace_paint_tag " +
                "to know which slot is currently in use (e.g. the LLM sees '142 triangles tagged " +
                "slot 2' and can decide to remap to slot 3). Returns counts for color, support, " +
                "seam, and fuzzy-skin paint, plus paint_history (canUndo / canRedo) and " +
                "total_triangle_count when at least one paint kind has been authored."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf("model_id" to Schemas.string("Model id from list_placed_models")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val id = args.optString("model_id").trim()
            val m = ws.placedModels.value.firstOrNull { it.id == id }
                ?: return ToolResult.error("No model with id '$id'.")

            fun encode(arr: ByteArray?): JSONObject = JSONObject().apply {
                put("authored", arr != null)
                if (arr != null) {
                    val h = histogram(arr)
                    val obj = JSONObject()
                    for ((tag, count) in h.toSortedMap()) obj.put(tag.toString(), count)
                    put("counts", obj)
                    put("painted_tris", arr.count { it.toInt() != 0 })
                    put("total_tris", arr.size)
                }
            }

            // Triangle count comes from any non-null paint array
            // (they're all parallel to the source mesh).
            val triCount = m.paintFilamentIndex?.size
                ?: m.supportFlags?.size
                ?: m.seamFlags?.size
                ?: m.fuzzySkinFlags?.size

            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", id)
                if (triCount != null) put("total_triangle_count", triCount)
                put("color", encode(m.paintFilamentIndex))
                put("support", encode(m.supportFlags))
                put("seam", encode(m.seamFlags))
                put("fuzzy_skin", encode(m.fuzzySkinFlags))
                put("brim_ear_count", m.brimEars.size)
            }

            val text = buildString {
                appendLine("Paint summary for ${m.label}:")
                if (triCount != null) appendLine("  total triangles: $triCount")
                fun line(label: String, arr: ByteArray?) {
                    if (arr == null) {
                        appendLine("  $label: not authored")
                    } else {
                        val painted = arr.count { it.toInt() != 0 }
                        val nonZero = histogram(arr).filterKeys { it != 0 }
                        appendLine("  $label: $painted / ${arr.size} painted; ${nonZero.toSortedMap()}")
                    }
                }
                line("color", m.paintFilamentIndex)
                line("support", m.supportFlags)
                line("seam", m.seamFlags)
                line("fuzzy_skin", m.fuzzySkinFlags)
                if (m.brimEars.isNotEmpty()) appendLine("  brim ears: ${m.brimEars.size}")
            }
            return ToolResult.ok(text.trim(), body)
        }
    }

    class ClearPaint(private val ws: WorkspaceModel) : Tool {
        override val name = "clear_paint"
        override val description =
            "Wipe paint state on a model. kind='color' clears filament-slot tags; 'support', " +
                "'seam', 'fuzzy_skin' clear those respectively. kind='all' (or omitted) wipes " +
                "all four kinds. Recorded in paint history so paint_undo restores it."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id from list_placed_models"),
                "kind" to Schemas.string("'color' | 'support' | 'seam' | 'fuzzy_skin' | 'all' (default 'all')"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val id = args.optString("model_id").trim()
            if (id.isEmpty()) return ToolResult.error("'model_id' is required.")
            if (ws.placedModels.value.none { it.id == id }) {
                return ToolResult.error("No model with id '$id'.")
            }
            val rawKind = args.optString("kind", "all").lowercase()
            val kind = if (rawKind == "all") null
                else parsePaintKind(rawKind)
                    ?: return ToolResult.error("Unknown kind '$rawKind'. Use color|support|seam|fuzzy_skin|all.")
            ws.emit(WorkspaceAction.ClearPaint(id, kind))
            return success(
                if (kind == null) "Cleared all paint on $id." else "Cleared $rawKind paint on $id.",
                JSONObject().apply {
                    put("model_id", id)
                    put("kind", kind?.name?.lowercase() ?: "all")
                },
            )
        }
    }

    class ReplacePaintTag(private val ws: WorkspaceModel) : Tool {
        override val name = "replace_paint_tag"
        override val description =
            "Re-tag every triangle currently tagged `from_tag` to `to_tag` on the given paint " +
                "kind. The canonical 'replace blue with red' use case: get_paint_summary tells " +
                "the LLM the model has triangles tagged slot 2 (blue) — call replace_paint_tag(" +
                "kind='color', from_tag=2, to_tag=3) to recolor them all to slot 3. " +
                "to_tag=0 is a partial clear (drops only triangles matching from_tag). " +
                "For support/seam, valid tags are 0 (none), 1 (ENFORCER), 2 (BLOCKER); " +
                "for fuzzy_skin, only 0 / 1. For color, 0..32 (0 = unpainted, 1..32 = filament slot). " +
                "Recorded in paint history so paint_undo restores it."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "from_tag", "to_tag"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "kind" to Schemas.string("'color' (default) | 'support' | 'seam' | 'fuzzy_skin'"),
                "from_tag" to Schemas.integer("Existing tag to find"),
                "to_tag" to Schemas.integer("New tag to assign in its place"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val id = args.optString("model_id").trim()
            if (id.isEmpty()) return ToolResult.error("'model_id' is required.")
            val model = ws.placedModels.value.firstOrNull { it.id == id }
                ?: return ToolResult.error("No model with id '$id'.")
            val kind = parsePaintKind(args.optString("kind", "color"))
                ?: return ToolResult.error("Unknown kind. Use color|support|seam|fuzzy_skin.")
            val fromTag = args.optInt("from_tag", -1)
            val toTag = args.optInt("to_tag", -1)
            if (fromTag !in 0..255 || toTag !in 0..255) {
                return ToolResult.error("from_tag and to_tag must each be in 0..255.")
            }
            // Per-kind range checks so a tool caller doesn't write a
            // tag the slicer will silently ignore.
            val maxTag = when (kind) {
                WorkspaceAction.PaintKind.Color -> dev.orcaxr.app.MAX_PAINT_SLOTS
                WorkspaceAction.PaintKind.Support -> 2
                WorkspaceAction.PaintKind.Seam -> 2
                WorkspaceAction.PaintKind.FuzzySkin -> 1
            }
            if (fromTag > maxTag || toTag > maxTag) {
                return ToolResult.error(
                    "Tag exceeds max for ${kind.name.lowercase()} (max=$maxTag).",
                )
            }
            val arr = arrayFor(model, kind)
            if (arr == null) {
                return ToolResult.error(
                    "Model '$id' has no ${kind.name.lowercase()} paint authored. Paint at least one face first.",
                )
            }
            val matchCount = arr.count { (it.toInt() and 0xff) == fromTag }
            ws.emit(WorkspaceAction.ReplacePaintTag(id, kind, fromTag, toTag))
            return success(
                "Re-tagging $matchCount triangle(s) on $id: ${kind.name.lowercase()} $fromTag → $toTag.",
                JSONObject().apply {
                    put("model_id", id)
                    put("kind", kind.name.lowercase())
                    put("from_tag", fromTag)
                    put("to_tag", toTag)
                    put("matched_triangle_count", matchCount)
                },
            )
        }
    }

    class PaintSplitPlane(private val ws: WorkspaceModel) : Tool {
        override val name = "paint_split_plane"
        override val description =
            "Bulk-paint every triangle of a model based on which side of an axis-aligned plane " +
                "its centroid lies on. Plane lives in the model's centered preview frame: bbox " +
                "XY-center at the origin, Z-min on the bed. Defaults (axis='x', plane_mm=0) split " +
                "the mesh down the middle along bed-X — pair with negative_tag=1, positive_tag=2 " +
                "for the canonical 'left red, right blue' two-color paint. axis is one of " +
                "'x' (bed left/right) | 'y' (bed front/back) | 'z' (height). For color paint the " +
                "tags are filament slots 1..32 (0 = unpainted); support/seam accept 0..2; " +
                "fuzzy_skin accepts 0..1. Replaces any prior paint of the same kind on the model. " +
                "Recorded in paint history so paint_undo restores it."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "negative_tag", "positive_tag"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id from list_placed_models"),
                "kind" to Schemas.string("'color' (default) | 'support' | 'seam' | 'fuzzy_skin'"),
                "axis" to Schemas.string("'x' (default) | 'y' | 'z'"),
                "plane_mm" to Schemas.number("Plane offset in mm along the chosen axis. Default 0 = bbox center."),
                "negative_tag" to Schemas.integer("Tag for triangles whose centroid is on the negative side"),
                "positive_tag" to Schemas.integer("Tag for triangles on the positive side"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val id = args.optString("model_id").trim()
            if (id.isEmpty()) return ToolResult.error("'model_id' is required.")
            if (ws.placedModels.value.none { it.id == id }) {
                return ToolResult.error("No model with id '$id'.")
            }
            val kind = parsePaintKind(args.optString("kind", "color"))
                ?: return ToolResult.error("Unknown kind. Use color|support|seam|fuzzy_skin.")
            val axisRaw = args.optString("axis", "x").lowercase()
            val axis = when (axisRaw) {
                "x" -> WorkspaceAction.SplitAxis.X
                "y" -> WorkspaceAction.SplitAxis.Y
                "z" -> WorkspaceAction.SplitAxis.Z
                else -> return ToolResult.error("Unknown axis '$axisRaw'. Use x|y|z.")
            }
            val planeMm = args.optFloat("plane_mm") ?: 0f
            val negTag = args.optInt("negative_tag", -1)
            val posTag = args.optInt("positive_tag", -1)
            if (negTag !in 0..255 || posTag !in 0..255) {
                return ToolResult.error("negative_tag and positive_tag must each be in 0..255.")
            }
            val maxTag = when (kind) {
                WorkspaceAction.PaintKind.Color -> dev.orcaxr.app.MAX_PAINT_SLOTS
                WorkspaceAction.PaintKind.Support -> 2
                WorkspaceAction.PaintKind.Seam -> 2
                WorkspaceAction.PaintKind.FuzzySkin -> 1
            }
            if (negTag > maxTag || posTag > maxTag) {
                return ToolResult.error(
                    "Tag exceeds max for ${kind.name.lowercase()} (max=$maxTag).",
                )
            }
            ws.emit(
                WorkspaceAction.PaintPlaneSplit(
                    modelId = id,
                    kind = kind,
                    axis = axis,
                    planeMm = planeMm,
                    negativeTag = negTag,
                    positiveTag = posTag,
                ),
            )
            return success(
                "Plane-split paint requested on $id (${kind.name.lowercase()} along ${axis.name} @ ${planeMm}mm; " +
                    "neg=$negTag, pos=$posTag).",
                JSONObject().apply {
                    put("model_id", id)
                    put("kind", kind.name.lowercase())
                    put("axis", axis.name.lowercase())
                    put("plane_mm", planeMm.toDouble())
                    put("negative_tag", negTag)
                    put("positive_tag", posTag)
                },
            )
        }
    }

    class PaintUndo(private val ws: WorkspaceModel) : Tool {
        override val name = "paint_undo"
        override val description =
            "Undo the most recent paint stroke on a model (works for both XR-driven and " +
                "MCP-driven paint changes — they share the same history)."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf("model_id" to Schemas.string("Model id")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val id = args.optString("model_id").trim()
            if (id.isEmpty()) return ToolResult.error("'model_id' is required.")
            ws.emit(WorkspaceAction.PaintUndo(id))
            return success("Paint undo requested for $id.", JSONObject().apply { put("model_id", id) })
        }
    }

    class PaintRedo(private val ws: WorkspaceModel) : Tool {
        override val name = "paint_redo"
        override val description = "Redo a previously-undone paint stroke."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf("model_id" to Schemas.string("Model id")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            requireAttached(ws)?.let { return it }
            val id = args.optString("model_id").trim()
            if (id.isEmpty()) return ToolResult.error("'model_id' is required.")
            ws.emit(WorkspaceAction.PaintRedo(id))
            return success("Paint redo requested for $id.", JSONObject().apply { put("model_id", id) })
        }
    }

    class FlushActions(private val ws: WorkspaceModel) : Tool {
        override val name = "flush_actions"
        override val description =
            "Block until every action emitted before this call has been processed by the host " +
                "binding. Use this between a mutating action (replace_paint_tag, transform_model, " +
                "clear_paint, etc.) and a read-after-write that depends on the post-mutation state " +
                "(paint_slab with merge='only_tagged', paint_geodesic_disc whose anchor depends on " +
                "freshly-painted tris, etc.). Without flush_actions the second tool can read pre-" +
                "mutation state because action dispatch is async — the JSON-RPC handler returns " +
                "while the action is still in the queue. Times out after [timeout_ms] (default 5 s) " +
                "if the host isn't draining (rare; typically means the activity backgrounded mid-" +
                "call). Returns the per-id watermark so callers can verify drain completed."
        override val inputSchema = Schemas.obj(
            properties = mapOf(
                "timeout_ms" to Schemas.integer("Wait timeout in ms (default 5000, max 30000)"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            // Snapshot the watermark BEFORE entering the wait so we
            // know what id we need the binding to reach. With every
            // emit incrementing _lastEmittedId atomically (under
            // emitMutex), this is a stable target.
            val target = ws.lastEmittedActionId.value
            val timeoutMs = args.optInt("timeout_ms", 5000).coerceIn(1, 30_000).toLong()
            val drained = kotlinx.coroutines.withTimeoutOrNull(timeoutMs) {
                ws.lastDrainedActionId
                    .first { it >= target }
            }
            val body = JSONObject().apply {
                put("ok", drained != null)
                put("target_id", target)
                put("drained_id", ws.lastDrainedActionId.value)
                put("timed_out", drained == null)
            }
            val text = if (drained != null) {
                "Drained $target action(s)."
            } else {
                "flush_actions timed out after ${timeoutMs}ms (target=$target, drained=${ws.lastDrainedActionId.value}). Activity may have backgrounded."
            }
            return if (drained != null) ToolResult.ok(text, body)
                   else ToolResult.error(text, body)
        }
    }

    private fun encodeVolume(v: PlacedVolume): JSONObject = JSONObject().apply {
        put("id", v.id)
        put("type", v.type.name)
        put("source_path", v.source.absolutePath)
        put("translate_x_mm", v.translateXmm)
        put("translate_y_mm", v.translateYmm)
        put("translate_z_mm", v.translateZmm)
        put("rot_x_deg", v.rotXDeg)
        put("rot_y_deg", v.rotYDeg)
        put("rot_z_deg", v.rotZDeg)
        put("scale_x_pct", v.scaleXPct)
        put("scale_y_pct", v.scaleYPct)
        put("scale_z_pct", v.scaleZPct)
        put("mirror_x", v.mirrorX)
        put("mirror_y", v.mirrorY)
        put("mirror_z", v.mirrorZ)
        put("config_overrides_count", v.configOverrides.size)
    }
}

/** `org.json` doesn't have a Float helper; round-trip through Double. */
private fun JSONObject.optFloat(key: String): Float? =
    if (has(key) && !isNull(key)) optDouble(key, Double.NaN).takeIf { !it.isNaN() }?.toFloat() else null
