package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.WipeTowerPlacement
import dev.orcaxr.app.footprintMm
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject

/**
 * Roadmap A13 — wipe-tower auto-positioning MCP tools.
 *
 *   `auto_position_wipe_tower(plate_id?, prefer?, tower_width_mm?,
 *                              tower_depth_mm?, safety_mm?, persist?)`
 *
 * Walks the active plate's PlacedModels, computes their XY AABBs in
 * printer frame, scores 8 candidate tower positions via
 * [WipeTowerPlacement.score], and returns the best pick. When
 * `persist=true` (default), the picked X/Y are written to
 * [UserPreferences.wipeTowerXOverride] / [.wipeTowerYOverride] AND
 * [UserPreferences.wipeTowerAutoPosition] is flipped on so the next
 * `slice_active_plate` call uses them.
 *
 * Bed extents come from the active SlicerProfile (via ToolContext).
 * If the profile doesn't expose them we fall back to the U1's 270×270
 * default — same shape as the profile picker's machine resolver.
 */
internal object WipeTowerTools {

    fun all(workspace: WorkspaceModel, ctx: ToolContext): List<Tool> = listOf(
        AutoPositionWipeTower(workspace, ctx),
    )

    class AutoPositionWipeTower(
        private val workspace: WorkspaceModel,
        private val ctx: ToolContext,
    ) : Tool {
        override val name = "auto_position_wipe_tower"
        override val description =
            "Pick a wipe-tower position that maximizes clearance from every part on the active " +
                "plate. Evaluates 8 candidates (4 corners + 4 cardinal mid-edges); ties broken by " +
                "the `prefer` bias (default 'back-left' — XR users look front-down at the bed so " +
                "back-left is least-obscured). When `persist` is true (default) the picked values " +
                "are written to UserPreferences.wipeTowerXOverride / wipeTowerYOverride and " +
                "wipeTowerAutoPosition is flipped on; the next slice consumes them via SAFE_KEYS " +
                "wipe_tower_x / wipe_tower_y. See ROADMAP.md A13."
        override val inputSchema = Schemas.obj(
            required = emptyList(),
            properties = mapOf(
                "plate_id" to JSONObject().apply {
                    put("type", "integer")
                    put("description", "Plate to score (defaults to the active plate).")
                },
                "prefer" to Schemas.string(
                    "Tie-break preference: 'back-left' (default), 'back-right', 'front-left', " +
                        "'front-right', or 'largest-clearance' (strict argmax, no bias)."
                ),
                "tower_width_mm" to JSONObject().apply {
                    put("type", "number")
                    put("description", "Tower width in mm. Default 60 (matches Snapmaker U1).")
                },
                "tower_depth_mm" to JSONObject().apply {
                    put("type", "number")
                    put("description", "Tower depth in mm. Defaults to tower_width_mm.")
                },
                "safety_mm" to JSONObject().apply {
                    put("type", "number")
                    put("description", "Extra safety margin around the tower during scoring (mm). Default 5.")
                },
                "persist" to JSONObject().apply {
                    put("type", "boolean")
                    put("description", "When true (default), write the result to UserPreferences and flip wipe_tower_auto on.")
                },
            ),
        )

        override suspend fun call(args: JSONObject): ToolResult {
            val plateId = if (args.has("plate_id")) args.getInt("plate_id") else workspace.activePlateId.value
            val prefer = WipeTowerPlacement.Bias.parse(args.optString("prefer", null))
            val towerW = args.optDouble("tower_width_mm", 60.0).toFloat()
            val towerD = args.optDouble("tower_depth_mm", towerW.toDouble()).toFloat()
            val safety = args.optDouble("safety_mm", 5.0).toFloat()
            val persist = args.optBoolean("persist", true)

            val parts = workspace.placedModels.value
                .filter { it.plateId == plateId }
                .map { m ->
                    val (w, d) = m.footprintMm()
                    val cx = m.translateXmm
                    val cy = m.translateYmm
                    WipeTowerPlacement.AabbXY.of(cx, cy, w.coerceAtLeast(1f), d.coerceAtLeast(1f))
                }

            val (bedW, bedD) = resolveBedExtents()

            val pick = WipeTowerPlacement.score(
                parts = parts,
                bedW = bedW,
                bedD = bedD,
                towerW = towerW,
                towerD = towerD,
                safetyMm = safety,
                bias = prefer,
            )

            if (persist) {
                ctx.prefs.wipeTowerAutoPosition = true
                ctx.prefs.wipeTowerXOverride = pick.xMm
                ctx.prefs.wipeTowerYOverride = pick.yMm
            }

            val body = JSONObject().apply {
                put("ok", true)
                put("plate_id", plateId)
                put("part_count", parts.size)
                put("bed_width_mm", bedW)
                put("bed_depth_mm", bedD)
                put("tower_width_mm", towerW)
                put("tower_depth_mm", towerD)
                put("safety_mm", safety)
                put("prefer", prefer.name)
                put("picked_x_mm", pick.xMm)
                put("picked_y_mm", pick.yMm)
                put("clearance_mm", if (pick.clearanceMm.isInfinite()) JSONObject.NULL else pick.clearanceMm)
                put("label", pick.label)
                put("persisted", persist)
                put("part_aabbs", JSONArray().apply {
                    for (p in parts) put(JSONObject().apply {
                        put("x_min", p.xMin); put("y_min", p.yMin)
                        put("x_max", p.xMax); put("y_max", p.yMax)
                    })
                })
            }
            return ToolResult.ok(body.toString(), body)
        }

        /**
         * Pull bed X / Y extents out of the active profile. Falls back
         * to the U1's 270x270 if the profile doesn't have parseable
         * `printable_area` / `bed_size` keys.
         */
        private fun resolveBedExtents(): Pair<Float, Float> {
            val profile = ctx.prefs.lastProfileOrDefault()
            val cfg = profile.config
            // OrcaSlicer's "printable_area" is a comma-separated list
            // of points "x1x y1, x2 y2 ..." defining the bed polygon.
            // Its bbox is the "bed_size".
            val area = cfg["printable_area"].orEmpty()
            if (area.isNotBlank()) {
                val pts = area.split(",").mapNotNull { entry ->
                    val (x, y) = entry.trim().split(Regex("\\s+")).let {
                        if (it.size < 2) return@mapNotNull null
                        it[0].toFloatOrNull() to it[1].toFloatOrNull()
                    }
                    if (x != null && y != null) x to y else null
                }
                if (pts.isNotEmpty()) {
                    val xs = pts.map { it.first }
                    val ys = pts.map { it.second }
                    val w = xs.max() - xs.min()
                    val d = ys.max() - ys.min()
                    if (w > 1f && d > 1f) return w to d
                }
            }
            return 270f to 270f
        }
    }
}
