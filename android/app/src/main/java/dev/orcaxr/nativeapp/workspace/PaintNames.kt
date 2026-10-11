package dev.orcaxr.nativeapp.workspace

import androidx.annotation.StringRes
import dev.orcaxr.core.PaintChannel
import dev.orcaxr.core.PaintToolKind
import dev.orcaxr.nativeapp.R

/** The paint panel's names (`PaintPanel.ts`) as string resources. */
internal object PaintNames {
    @StringRes fun channel(channel: PaintChannel): Int = when (channel) {
        PaintChannel.COLOR -> R.string.paint_channel_color
        PaintChannel.SUPPORT -> R.string.paint_channel_support
        PaintChannel.SEAM -> R.string.paint_channel_seam
        PaintChannel.FUZZY_SKIN -> R.string.paint_channel_fuzzy_skin
    }

    @StringRes fun tool(tool: PaintToolKind): Int = when (tool) {
        PaintToolKind.CIRCLE -> R.string.paint_tool_circle
        PaintToolKind.SPHERE -> R.string.paint_tool_sphere
        PaintToolKind.TRIANGLE -> R.string.paint_tool_triangle
        PaintToolKind.FILL -> R.string.paint_tool_fill
        PaintToolKind.HEIGHT_RANGE -> R.string.paint_tool_height_range
        PaintToolKind.GAP_FILL -> R.string.paint_tool_gap_fill
    }

    /** A channel state by its `String(value)`. */
    @StringRes fun state(key: String): Int = when (key) {
        "enforce" -> R.string.paint_state_enforce
        "block" -> R.string.paint_state_block
        "prefer" -> R.string.paint_state_prefer
        "avoid" -> R.string.paint_state_avoid
        else -> R.string.paint_state_fuzzy
    }

    @StringRes fun parameter(parameter: PaintParameter): Int = when (parameter) {
        PaintParameter.RADIUS -> R.string.paint_radius
        PaintParameter.SMART_FILL_ANGLE -> R.string.paint_smart_fill_angle
        PaintParameter.HEIGHT_RANGE -> R.string.paint_height_range
        PaintParameter.GAP_AREA -> R.string.paint_gap_area
    }

    /** The tool's name as the browser's status prints it (`Paint tool: circle`). */
    fun wire(tool: PaintToolKind): String = tool.wire

    fun steps(parameter: PaintParameter): Int = parameter.steps
    fun stepped(parameter: PaintParameter, value: Double): Double = parameter.stepped(value)
}
