package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.CalibrationRampGenerator
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject

/**
 * Roadmap B12 — generate a per-Z calibration ramp and emit it as a
 * batch of `add_custom_gcode_tick` actions onto the active plate.
 *
 * Composes B12 (the variable-ramp generator) with A11 (custom-gcode-
 * per-Z) without adding any new JNI surface. Lets the LLM-driven
 * workflow be a one-liner: `add_handy_model("calib_pa_tower")` then
 * `generate_calibration_ramp(kind="pressure_advance", start=0.02,
 * end=0.06, step=0.005, layers_per_band=10, layer_height_mm=0.2)`
 * — and the next slice produces a tower with PA ramping up the Z
 * axis.
 *
 * Mode = "replace" (default) clears the plate's existing ticks
 * before adding; "add" appends. Replace is the safer default because
 * a leftover tick from a prior calibration would corrupt the new
 * ramp's gcode.
 */
internal object CalibrationTools {

    fun all(workspace: WorkspaceModel): List<Tool> = listOf(
        GenerateCalibrationRamp(workspace),
    )

    class GenerateCalibrationRamp(private val ws: WorkspaceModel) : Tool {
        override val name = "generate_calibration_ramp"
        override val description =
            "Author a per-Z calibration ramp on the active plate by emitting one " +
                "Template-kind custom-gcode tick per band. Each band's body sets the " +
                "tunable parameter (PA / temperature / retraction / volumetric flow / " +
                "speed) to a value stepped from `start` toward `end` in `step` increments, " +
                "holding for `layers_per_band` layers. Combine with `add_handy_model` to " +
                "produce a complete calibration print. Mode='replace' (default) clears the " +
                "plate's existing ticks first; 'add' appends. See ROADMAP.md B12."
        override val inputSchema = Schemas.obj(
            required = listOf("kind", "start", "end", "step"),
            properties = mapOf(
                "kind" to Schemas.string(
                    "One of: 'pressure_advance', 'temperature', 'retraction', 'volumetric_flow', 'speed'."
                ),
                "start" to numberSchema("First band's value (units depend on kind: PA = mm·s², temp = °C, retraction = mm)."),
                "end" to numberSchema("Last band's value. Direction is inferred from sign(end - start); the sign of `step` is ignored."),
                "step" to numberSchema("Increment between consecutive bands. Must be non-zero."),
                "layers_per_band" to JSONObject().apply {
                    put("type", "integer")
                    put("description", "Layers per band. Default 10. Band height = layers_per_band × layer_height_mm.")
                },
                "layer_height_mm" to numberSchema("Active profile's layer height in mm. Default 0.2."),
                "first_band_z_mm" to numberSchema("Z height where the first band begins. Default 0.4 (skips the skirt)."),
                "plate_id" to JSONObject().apply {
                    put("type", "integer")
                    put("description", "Target plate. Defaults to the active plate.")
                },
                "mode" to Schemas.string("'replace' (default) or 'add'."),
            ),
        )

        override suspend fun call(args: JSONObject): ToolResult {
            val kind = parseKind(args.optString("kind", ""))
                ?: return ToolResult.error(
                    "kind must be one of: pressure_advance, temperature, retraction, volumetric_flow, speed.",
                )
            val start = args.optDouble("start", Double.NaN).toFloat()
            val end = args.optDouble("end", Double.NaN).toFloat()
            val step = args.optDouble("step", Double.NaN).toFloat()
            if (start.isNaN() || end.isNaN() || step.isNaN() || step == 0f) {
                return ToolResult.error("start, end, step must be numbers and step != 0.")
            }
            val layersPerBand = args.optInt("layers_per_band", 10)
            val layerHeight = args.optDouble("layer_height_mm", 0.2).toFloat()
            val firstBandZ = args.optDouble("first_band_z_mm", 0.4).toFloat()
            val plateId = if (args.has("plate_id")) args.getInt("plate_id") else ws.activePlateId.value
            val mode = args.optString("mode", "replace").lowercase().ifBlank { "replace" }
            if (mode != "replace" && mode != "add") {
                return ToolResult.error("mode must be 'replace' or 'add'.")
            }

            val params = runCatching {
                CalibrationRampGenerator.Params(
                    kind = kind,
                    start = start,
                    end = end,
                    step = step,
                    layersPerBand = layersPerBand,
                    layerHeightMm = layerHeight,
                    firstBandZmm = firstBandZ,
                )
            }.getOrElse { e ->
                return ToolResult.error("invalid params: ${e.message}")
            }

            val ticks = CalibrationRampGenerator.generate(params)
            if (ticks.isEmpty()) {
                return ToolResult.error("Generator produced 0 ticks — check start/end/step.")
            }

            if (mode == "replace") {
                ws.emit(WorkspaceAction.ClearCustomGcodeTicks(plateId = plateId))
            }
            for (t in ticks) {
                ws.emit(
                    WorkspaceAction.AddCustomGcodeTick(
                        plateId = plateId,
                        zMm = t.printZmm,
                        kind = "Template",
                        extruder = t.extruder,
                        color = t.color,
                        extra = t.extra,
                    ),
                )
            }

            val body = JSONObject().apply {
                put("ok", true)
                put("plate_id", plateId)
                put("kind", args.optString("kind"))
                put("band_count", ticks.size)
                put("first_z_mm", ticks.first().printZmm)
                put("last_z_mm", ticks.last().printZmm)
                put("mode", mode)
                put("preview", JSONArray().apply {
                    // Tiny preview: first + last band's body, useful
                    // for the LLM to verify the M-command shape
                    // without re-fetching all the ticks.
                    put(JSONObject().apply {
                        put("z_mm", ticks.first().printZmm); put("body", ticks.first().extra)
                    })
                    put(JSONObject().apply {
                        put("z_mm", ticks.last().printZmm); put("body", ticks.last().extra)
                    })
                })
            }
            return ToolResult.ok(body.toString(), body)
        }

        private fun numberSchema(description: String): JSONObject =
            JSONObject().apply {
                put("type", "number")
                put("description", description)
            }

        private fun parseKind(raw: String): CalibrationRampGenerator.Kind? = when (raw.lowercase()) {
            "pressure_advance", "pa" -> CalibrationRampGenerator.Kind.PressureAdvance
            "temperature", "temp" -> CalibrationRampGenerator.Kind.Temperature
            "retraction" -> CalibrationRampGenerator.Kind.Retraction
            "volumetric_flow", "flow" -> CalibrationRampGenerator.Kind.VolumetricFlow
            "speed" -> CalibrationRampGenerator.Kind.Speed
            else -> null
        }
    }
}
