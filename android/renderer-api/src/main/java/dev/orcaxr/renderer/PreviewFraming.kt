package dev.orcaxr.renderer

import kotlin.math.ceil
import kotlin.math.max

/**
 * Where a G-code preview sits on the bed, in millimetres: the bed drawn
 * under it (from the origin) and the area to frame. G-code carries no bed
 * size, so the project's bed grows to reach the toolpath's far corner.
 */
data class PreviewFraming(
    val bedWidthMm: Double,
    val bedDepthMm: Double,
    val minXMm: Double,
    val minYMm: Double,
    val maxXMm: Double,
    val maxYMm: Double,
) {
    companion object {
        /** The largest bed side the renderer draws. */
        const val MAX_BED_MM = 5000.0
        private const val GRID_MM = 10.0
        private const val MARGIN_MM = 5.0

        /** A bed side the renderer can draw: [mm] held within 1 mm and [MAX_BED_MM]. */
        fun drawable(mm: Double): Double = mm.coerceIn(1.0, MAX_BED_MM)

        /**
         * The framing for [toolpath] (its render-space bounds) on a bed of
         * [bedWidthMm] × [bedDepthMm], or that whole bed when it draws nothing.
         */
        fun of(toolpath: ToolpathGeometry?, bedWidthMm: Double = 200.0, bedDepthMm: Double = bedWidthMm): PreviewFraming {
            require(bedWidthMm in 1.0..MAX_BED_MM && bedDepthMm in 1.0..MAX_BED_MM)
            if (toolpath == null || toolpath.segments == 0) {
                return PreviewFraming(bedWidthMm, bedDepthMm, 0.0, 0.0, bedWidthMm, bedDepthMm)
            }
            val center = toolpath.center
            val half = toolpath.halfExtent
            // Render space is metres with y up and -z along the bed's y (RenderSpace.point).
            val minX = (center[0] - half[0]) * 1000.0
            val maxX = (center[0] + half[0]) * 1000.0
            val minY = -(center[2] + half[2]) * 1000.0
            val maxY = -(center[2] - half[2]) * 1000.0
            fun bed(side: Double, far: Double) = max(side, ceil(far / GRID_MM) * GRID_MM).coerceAtMost(MAX_BED_MM)
            return PreviewFraming(
                bed(bedWidthMm, maxX), bed(bedDepthMm, maxY),
                minX - MARGIN_MM, minY - MARGIN_MM, maxX + MARGIN_MM, maxY + MARGIN_MM,
            )
        }
    }
}
