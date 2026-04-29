package dev.orcaxr.app

import java.io.File

/**
 * Build-plate visualization: a wireframe grid the user's model sits on,
 * matching the bed dimensions of the selected printer profile. Drawn as
 * LINES so it shares the same rendering path as the toolpath GLB.
 *
 * Coordinates are in millimeters and centered on the bed center, so the
 * plate's local origin sits at the front-left bed corner only when
 * [centered] is false. We keep the same "mm in, scale outside" contract
 * as [ToolpathGlb] — callers apply a 1/x scale on the GltfModelEntity.
 *
 * The grid spacing (default 10 mm) gives 25×21 cells for a 250×210 mm
 * bed, which reads cleanly at headset distance without aliasing.
 */
object BuildPlateGlb {
    /** Fallback size when a profile doesn't supply `printable_area`.
     *  256×256 covers the Bambu A1 / generic mid-size FDM. */
    const val DEFAULT_SIZE_X_MM = 256.0f
    const val DEFAULT_SIZE_Y_MM = 256.0f
    const val DEFAULT_GRID_MM = 10.0f

    /**
     * Parse OrcaSlicer's `printable_area` representation (a comma-joined
     * list of corner points, each formatted as "Xmm`x`Ymm") into bed
     * width and depth in millimeters. The Snapmaker U1's value is e.g.
     *   "0.5x1,270.5x1,270.5x271,0.5x271"
     * giving a 270×270 mm bed.
     *
     * Returns null when the string is missing, empty, or unparseable —
     * caller should fall back to [DEFAULT_SIZE_X_MM] / [Y].
     */
    fun parsePrintableArea(printableArea: String?): Pair<Float, Float>? {
        val raw = printableArea?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        var minX = Float.POSITIVE_INFINITY
        var maxX = Float.NEGATIVE_INFINITY
        var minY = Float.POSITIVE_INFINITY
        var maxY = Float.NEGATIVE_INFINITY
        for (token in raw.split(',')) {
            val parts = token.trim().split('x')
            if (parts.size < 2) continue
            val x = parts[0].trim().toFloatOrNull() ?: continue
            val y = parts[1].trim().toFloatOrNull() ?: continue
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
        }
        if (!minX.isFinite() || !maxX.isFinite() || !minY.isFinite() || !maxY.isFinite()) return null
        val w = maxX - minX
        val h = maxY - minY
        if (w <= 1f || h <= 1f) return null
        return w to h
    }

    fun sizeFor(profile: SlicerProfile): Pair<Float, Float> =
        parsePrintableArea(profile.config["printable_area"])
            ?: (DEFAULT_SIZE_X_MM to DEFAULT_SIZE_Y_MM)

    fun write(
        out: File,
        sizeXmm: Float = DEFAULT_SIZE_X_MM,
        sizeYmm: Float = DEFAULT_SIZE_Y_MM,
        gridSpacingMm: Float = DEFAULT_GRID_MM,
    ) {
        val halfX = sizeXmm * 0.5f
        val halfY = sizeYmm * 0.5f

        val positions = ArrayList<Float>(2048)
        val colors = ArrayList<Float>(2048)
        val indices = ArrayList<Int>(2048)

        // Outline color (brighter cyan), grid color (dimmer cyan).
        val outlineR = 0.45f; val outlineG = 0.85f; val outlineB = 1.0f
        val gridR = 0.20f;    val gridG = 0.40f;    val gridB = 0.55f

        var vid = 0
        fun seg(ax: Float, ay: Float, bx: Float, by: Float, r: Float, g: Float, b: Float) {
            // Plate sits at z=0 (top surface). Toolpath/STL Z grows upward.
            positions += ax; positions += ay; positions += 0f
            positions += bx; positions += by; positions += 0f
            colors += r; colors += g; colors += b
            colors += r; colors += g; colors += b
            indices += vid++; indices += vid++
        }

        // Interior grid lines first so the outline reads cleanly on top.
        // Offset the loop start so we don't double-draw the perimeter
        // (handled by the outline pass).
        var x = -halfX + gridSpacingMm
        while (x < halfX - 1e-3f) {
            seg(x, -halfY, x, halfY, gridR, gridG, gridB)
            x += gridSpacingMm
        }
        var y = -halfY + gridSpacingMm
        while (y < halfY - 1e-3f) {
            seg(-halfX, y, halfX, y, gridR, gridG, gridB)
            y += gridSpacingMm
        }

        // Bed perimeter.
        seg(-halfX, -halfY,  halfX, -halfY, outlineR, outlineG, outlineB)
        seg( halfX, -halfY,  halfX,  halfY, outlineR, outlineG, outlineB)
        seg( halfX,  halfY, -halfX,  halfY, outlineR, outlineG, outlineB)
        seg(-halfX,  halfY, -halfX, -halfY, outlineR, outlineG, outlineB)

        // Origin tick: a small "+" at (0,0) so the user can read the bed
        // center. 4 mm half-length keeps it readable but unobtrusive.
        val tick = 4.0f
        seg(-tick, 0f, tick, 0f, 1.0f, 0.6f, 0.4f)
        seg(0f, -tick, 0f, tick, 1.0f, 0.6f, 0.4f)

        GlbBuilder(
            positions = positions.toFloatArray(),
            indices = indices.toIntArray(),
            mode = GlbBuilder.MODE_LINES,
            colors = colors.toFloatArray(),
        ).writeTo(out)
    }
}
