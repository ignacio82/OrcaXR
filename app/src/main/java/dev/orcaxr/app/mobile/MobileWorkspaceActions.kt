package dev.orcaxr.app.mobile

import dev.orcaxr.app.ToolDispatch
import dev.orcaxr.app.mcp.WorkspaceModel
import dev.orcaxr.app.mcp.tools.WorkspaceTools
import org.json.JSONObject

/**
 * Thin phone-UI wrappers over the WorkspaceTools the MobileWorkspace
 * binding re-architecture now applies on the single-model phone shell.
 * Every call goes through [ToolDispatch] → the exact MCP `Tool` the
 * network server uses, so the button and the agent path are identical
 * by construction ([[feedback_ui_mcp_parity]]). The committed effect
 * flows back via the binding (the wired action → reload / state /
 * slice), so the UI just fires and reports.
 *
 * Single-model phone: model id is always `mobile_loaded`, plate `1`.
 */
internal object MobileWorkspaceActions {

    private const val MODEL = "mobile_loaded"
    private const val PLATE = 1

    private fun ws() = WorkspaceModel.get()

    suspend fun cut(planeZmm: Float): ToolDispatch.Result =
        ToolDispatch.call(
            WorkspaceTools.CutModel(ws()),
            JSONObject().put("model_id", MODEL).put("plane_z_mm", planeZmm),
        )

    suspend fun simplify(targetTriangleCount: Int, maxError: Float): ToolDispatch.Result =
        ToolDispatch.call(
            WorkspaceTools.SimplifyModel(ws()),
            JSONObject().put("model_id", MODEL)
                .put("target_triangle_count", targetTriangleCount)
                .put("max_error", maxError.toDouble()),
        )

    suspend fun computeAdaptiveLayerHeights(quality: Float): ToolDispatch.Result =
        ToolDispatch.call(
            WorkspaceTools.ComputeAdaptiveLayerHeights(ws()),
            JSONObject().put("model_id", MODEL).put("quality", quality.toDouble()),
        )

    suspend fun clearLayerHeightProfile(): ToolDispatch.Result =
        ToolDispatch.call(
            WorkspaceTools.ClearLayerHeightProfile(ws()),
            JSONObject().put("model_id", MODEL),
        )

    suspend fun setObjectOverrides(overrides: Map<String, String>): ToolDispatch.Result =
        ToolDispatch.call(
            WorkspaceTools.SetObjectOverrides(ws()),
            JSONObject().put("model_id", MODEL)
                .put("overrides", JSONObject(overrides as Map<*, *>)),
        )

    suspend fun addGcodeTick(
        zMm: Float,
        kind: String,
        extruder: Int = 0,
        color: String = "",
        extra: String = "",
    ): ToolDispatch.Result =
        ToolDispatch.call(
            WorkspaceTools.AddCustomGcodeTick(ws()),
            JSONObject().put("plate_id", PLATE).put("z_mm", zMm).put("kind", kind)
                .put("extruder", extruder).put("color", color).put("extra", extra),
        )

    suspend fun removeGcodeTick(index: Int): ToolDispatch.Result =
        ToolDispatch.call(
            WorkspaceTools.RemoveCustomGcodeTick(ws()),
            JSONObject().put("plate_id", PLATE).put("index", index),
        )

    suspend fun clearGcodeTicks(): ToolDispatch.Result =
        ToolDispatch.call(
            WorkspaceTools.ClearCustomGcodeTicks(ws()),
            JSONObject().put("plate_id", PLATE),
        )

    suspend fun dropToBed(): ToolDispatch.Result =
        ToolDispatch.call(
            WorkspaceTools.DropToBed(ws()),
            JSONObject().put("model_id", MODEL),
        )

    suspend fun deleteModel(): ToolDispatch.Result =
        ToolDispatch.call(
            WorkspaceTools.DeleteModels(ws()),
            JSONObject().put("model_ids", org.json.JSONArray().put(MODEL)),
        )
}
