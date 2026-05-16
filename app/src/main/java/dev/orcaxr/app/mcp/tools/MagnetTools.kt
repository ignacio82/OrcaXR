package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.TierBCapability
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONObject

/**
 * "Add Magnets" MCP surface — recess N magnet-shaped pockets into a
 * model as `NEGATIVE_VOLUME`s (libslic3r boolean-subtracts them at
 * slice time) and auto-author one `PausePrint` tick so the user can
 * drop the physical magnets in mid-print before the model bridges a
 * roof over them.
 *
 * Non-destructive: the host's `source` / paint / support state is
 * preserved (mirrors the host-side [WorkspaceAction.AddMagnets]
 * contract). The heavy work (primitive build + placement + pause
 * authoring + re-preview) runs host-side in `MainActivity.runMagnets`
 * via the WorkspaceAction → BindWorkspaceModel callback path; this
 * tool only validates + emits, like `add_primitive`.
 *
 * v1 targets a single standalone model — `sliceMulti` does not yet
 * thread per-input volumes, so the host rejects multi-object plates.
 */
internal object MagnetTools {

    fun all(ctx: ToolContext): List<Tool> = listOf(AddMagnets(WorkspaceModel.get()))

    class AddMagnets(private val ws: WorkspaceModel) : Tool {
        override val name = "add_magnets"
        override val description =
            "Recess N magnet cavities (shape=disc or block) into a model as a symmetric " +
                "inset grid on its bounding-box bottom region, as NEGATIVE_VOLUMEs " +
                "(non-destructive — paint/support preserved), and author one PausePrint " +
                "tick at the pocket tops so the print pauses for magnet insertion before " +
                "it bridges a roof over them. shape=disc uses diameter_mm + height_mm; " +
                "shape=block uses x_mm + y_mm + z_mm (the PHYSICAL magnet — clearance_mm " +
                "is added to the cut). v1: single standalone model only."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "count", "shape"),
            properties = mapOf(
                "model_id" to Schemas.string("Target PlacedModel id."),
                "count" to Schemas.integer("Number of magnets (≥ 1)."),
                "shape" to Schemas.string("disc | block"),
                "diameter_mm" to Schemas.number("Disc magnet diameter (shape=disc)."),
                "height_mm" to Schemas.number("Disc magnet height/thickness (shape=disc)."),
                "x_mm" to Schemas.number("Block magnet X (shape=block)."),
                "y_mm" to Schemas.number("Block magnet Y (shape=block)."),
                "z_mm" to Schemas.number("Block magnet Z/height (shape=block)."),
                "clearance_mm" to Schemas.number("Cavity tolerance added to the magnet, default 0.2."),
                "roof_thickness_mm" to Schemas.number("Solid skin below + bridged roof above, default 0.8."),
                "edge_margin_mm" to Schemas.number("Grid inset from footprint edges, default 3."),
            ),
        )

        override suspend fun call(args: JSONObject): ToolResult {
            if (!ws.attached.value) {
                return ToolResult.error(
                    "OrcaXR's main window isn't attached. Bring the app to the foreground.",
                )
            }
            if (!ws.isCapabilityWired(TierBCapability.AddMagnets)) {
                return ToolResult.error("add_magnets is not wired in this build.")
            }
            val modelId = args.optString("model_id").trim()
            if (modelId.isEmpty()) return ToolResult.error("'model_id' is required.")
            if (ws.placedModels.value.none { it.id == modelId }) {
                return ToolResult.error("No model with id '$modelId'.")
            }
            val count = args.optInt("count", 0)
            if (count < 1) return ToolResult.error("'count' must be ≥ 1.")
            val shape = args.optString("shape").trim().lowercase()
            if (shape != "disc" && shape != "block") {
                return ToolResult.error("'shape' must be 'disc' or 'block'.")
            }

            fun f(key: String, def: Float): Float =
                args.opt(key)?.let { (it as? Number)?.toFloat() } ?: def

            val diameterMm = f("diameter_mm", 0f)
            val heightMm = f("height_mm", 0f)
            val blockXmm = f("x_mm", 0f)
            val blockYmm = f("y_mm", 0f)
            val blockZmm = f("z_mm", 0f)
            val clearanceMm = f("clearance_mm", 0.2f)
            val roofThicknessMm = f("roof_thickness_mm", 0.8f)
            val edgeMarginMm = f("edge_margin_mm", 3f)

            if (shape == "disc" && (diameterMm <= 0f || heightMm <= 0f)) {
                return ToolResult.error("shape=disc needs positive diameter_mm and height_mm.")
            }
            if (shape == "block" && (blockXmm <= 0f || blockYmm <= 0f || blockZmm <= 0f)) {
                return ToolResult.error("shape=block needs positive x_mm, y_mm and z_mm.")
            }
            if (clearanceMm < 0f || roofThicknessMm < 0f || edgeMarginMm < 0f) {
                return ToolResult.error(
                    "clearance_mm / roof_thickness_mm / edge_margin_mm must be ≥ 0.",
                )
            }

            ws.emit(
                WorkspaceAction.AddMagnets(
                    modelId = modelId,
                    count = count,
                    shape = shape,
                    diameterMm = diameterMm,
                    heightMm = heightMm,
                    blockXmm = blockXmm,
                    blockYmm = blockYmm,
                    blockZmm = blockZmm,
                    clearanceMm = clearanceMm,
                    roofThicknessMm = roofThicknessMm,
                    edgeMarginMm = edgeMarginMm,
                ),
            )

            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", modelId)
                put("count", count)
                put("shape", shape)
                put("note", "Placement, pause-Z and re-preview run host-side; v1 requires a single standalone model.")
            }
            return ToolResult.ok(
                "Adding $count $shape magnet pocket(s) + a pause tick to $modelId.",
                body,
            )
        }
    }
}
