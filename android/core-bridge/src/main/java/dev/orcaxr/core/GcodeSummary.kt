package dev.orcaxr.core

import org.json.JSONArray
import org.json.JSONObject

/** One tool's usage, as the artifact states it; 0-based [toolIndex] in the artifact's own filament order. */
data class GcodeArtifactTool(
    val toolIndex: Int,
    val lengthMm: Double?,
    val volumeCm3: Double?,
    val weightG: Double?,
    val colorHex: String?,
    val material: String?,
)

/** What a finished artifact states about itself (the browser's
 * `GcodeArtifactSummary`): read, never recomputed, so a figure it does not
 * state is null and a zero it states is kept. [totalCost] is in the
 * profile's currency, which the file does not name. */
data class GcodeArtifactSummary(
    val perTool: List<GcodeArtifactTool>,
    val totalWeightG: Double?,
    val totalCost: Double?,
    val toolChanges: Double?,
    val layerCount: Double?,
    val estimatedSeconds: Double?,
    val firstLayerSeconds: Double?,
    val empty: Boolean,
)

/** One tool line of the preview panel; [colorHex] only when it is a CSS hex colour. */
data class GcodeArtifactToolLine(val toolIndex: Int, val colorHex: String?, val text: String)

/** The summary as the browser's preview panel words it: the totals line, then each tool that used filament. */
data class GcodeArtifactText(val totals: String, val tools: List<GcodeArtifactToolLine>)

/** The shared core's summary of one sealed artifact and its wording. */
data class GcodeArtifactStatement(val summary: GcodeArtifactSummary, val text: GcodeArtifactText)

/** Relational checks after the generated shape validator. */
internal object GcodeSummary {
    private fun number(value: JSONObject, key: String): Double? = if (value.has(key)) value.getDouble(key) else null
    private fun string(value: JSONObject, key: String): String? = if (value.has(key)) value.getString(key) else null
    private fun <T> list(values: JSONArray, read: (JSONObject) -> T): List<T> = List(values.length()) { read(values.getJSONObject(it)) }

    fun statement(value: JSONObject): GcodeArtifactStatement {
        val summary = value.getJSONObject("summary")
        val tools = list(summary.getJSONArray("perTool")) { tool ->
            GcodeArtifactTool(
                tool.getInt("toolIndex"),
                number(tool, "lengthMm"),
                number(tool, "volumeCm3"),
                number(tool, "weightG"),
                string(tool, "colorHex"),
                string(tool, "material"),
            )
        }
        // Tools are the artifact's filaments in order; a line names a tool that exists.
        require(tools.withIndex().all { (index, tool) -> tool.toolIndex == index }) { "Invalid shared G-code metadata" }
        val text = value.getJSONObject("text")
        val lines = list(text.getJSONArray("tools")) { line ->
            GcodeArtifactToolLine(line.getInt("toolIndex"), string(line, "colorHex"), line.getString("text"))
        }
        require(lines.all { it.toolIndex < tools.size } && lines.zipWithNext().all { (a, b) -> a.toolIndex < b.toolIndex }) {
            "Invalid shared G-code metadata"
        }
        return GcodeArtifactStatement(
            GcodeArtifactSummary(
                tools,
                number(summary, "totalWeightG"),
                number(summary, "totalCost"),
                number(summary, "toolChanges"),
                number(summary, "layerCount"),
                number(summary, "estimatedSeconds"),
                number(summary, "firstLayerSeconds"),
                summary.getBoolean("empty"),
            ),
            GcodeArtifactText(text.getString("totals"), lines),
        )
    }
}
