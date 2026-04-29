package dev.orcaxr.app

import java.io.File

/**
 * Builds a GLB representing a [ParsedToolpath] as a set of line
 * segments. Mode = LINES, so each pair of consecutive vertices in the
 * index buffer defines one segment.
 *
 * Coordinates are recentered on the toolpath's XY centroid + zMin so
 * the resulting model sits at the origin and faces +Z. Units are
 * preserved (millimeters); SceneCore renders that as meters by default,
 * so a 20 mm cube becomes 20 m wide if positioned 1:1 — callers should
 * apply a scale factor (e.g. 1/1000 to render real-size, or 1/100 for
 * a "diorama" preview).
 *
 * [maxLayerInclusive], if non-null, clips the output to layers
 * `0..maxLayerInclusive` (indices into [ParsedToolpath.layerZs]). Used
 * by the layer scrubber UI.
 */
object ToolpathGlb {
    fun write(
        toolpath: ParsedToolpath,
        out: File,
        maxLayerInclusive: Int? = null,
        includeTravels: Boolean = false,
        /**
         * Per-extruder color palette (`#RRGGBB` strings). When the
         * parsed toolpath contains ≥2 distinct extruder indices, we
         * color segments by extruder using this palette — that's the
         * UX win for multi-color slices on the U1's 4-tool toolchanger.
         * For single-tool slices we fall back to role-based coloring
         * (more informative than coloring everything one filament's
         * shade).
         */
        extruderPalette: List<String>? = null,
    ) {
        val segs = if (maxLayerInclusive == null || maxLayerInclusive >= toolpath.layerZs.lastIndex) {
            toolpath.segments
        } else {
            val zCutoff = toolpath.layerZs.getOrNull(maxLayerInclusive) ?: Float.POSITIVE_INFINITY
            // +epsilon so equality on float Z still falls inside.
            toolpath.segments.filter { it.z <= zCutoff + 1e-4f }
        }

        val activeTravels = if (includeTravels) {
            if (maxLayerInclusive == null || maxLayerInclusive >= toolpath.layerZs.lastIndex) {
                toolpath.travels
            } else {
                val zCutoff = toolpath.layerZs.getOrNull(maxLayerInclusive) ?: Float.POSITIVE_INFINITY
                toolpath.travels.filter { it.z <= zCutoff + 1e-4f }
            }
        } else {
            emptyList()
        }

        val totalSegs = segs.size + activeTravels.size
        if (totalSegs == 0) {
            // Emit a single degenerate line so GLB load doesn't crash on
            // an empty mesh; callers should check stats.extrusionSegments
            // before bothering to render.
            GlbBuilder(
                positions = floatArrayOf(0f, 0f, 0f, 0f, 0f, 0f),
                indices = intArrayOf(0, 1),
                mode = GlbBuilder.MODE_LINES,
            ).writeTo(out)
            return
        }

        // Recenter on bbox xy-center + zMin so the model sits on the
        // SceneCore origin floor.
        val cx = (toolpath.stats.bboxMin.x + toolpath.stats.bboxMax.x) * 0.5f
        val cy = (toolpath.stats.bboxMin.y + toolpath.stats.bboxMax.y) * 0.5f
        val cz = toolpath.stats.bboxMin.z

        val positions = FloatArray(totalSegs * 6)
        val colors = FloatArray(totalSegs * 6)
        val indices = IntArray(totalSegs * 2)

        // Two coloring strategies:
        //  - multi-color slice (≥2 distinct extruders in segs): color
        //    each segment by its tool index via [extruderPalette],
        //    matching the slot swatches in LeftProjectPanel.
        //  - single-tool slice: color by extrusion role (outer wall =
        //    red, infill = blue, support = gray — see RoleColors).
        //    When role is Unknown (G-code skipped `;TYPE:` tagging) we
        //    fall through to a Z-based gradient so the toolpath still
        //    reads as a height map.
        val distinctExtruders = segs.asSequence().map { it.extruder }.distinct().take(2).count()
        val byExtruder = distinctExtruders >= 2 && !extruderPalette.isNullOrEmpty()
        val palette: List<Rgb> = extruderPalette
            ?.map { hexToRgb(it) ?: Rgb(0.6f, 0.6f, 0.6f) }
            .orEmpty()

        val zRange = (toolpath.stats.bboxMax.z - toolpath.stats.bboxMin.z).coerceAtLeast(1e-3f)

        var pi = 0; var ci = 0; var ii = 0
        var vertexId = 0
        for (s in segs) {
            val rgb = when {
                byExtruder -> palette.getOrNull(s.extruder.coerceAtLeast(0) % palette.size.coerceAtLeast(1))
                    ?: RoleColors.colorFor(s.role)
                s.role == ExtrusionRole.Unknown -> {
                    val t = ((s.z - toolpath.stats.bboxMin.z) / zRange).coerceIn(0f, 1f)
                    Rgb(1.0f - t, 1.0f - kotlin.math.abs(t - 0.5f) * 2.0f, t)
                }
                else -> RoleColors.colorFor(s.role)
            }

            positions[pi++] = s.start.x - cx
            positions[pi++] = s.start.y - cy
            positions[pi++] = s.start.z - cz
            positions[pi++] = s.end.x - cx
            positions[pi++] = s.end.y - cy
            positions[pi++] = s.end.z - cz

            colors[ci++] = rgb.r; colors[ci++] = rgb.g; colors[ci++] = rgb.b
            colors[ci++] = rgb.r; colors[ci++] = rgb.g; colors[ci++] = rgb.b

            indices[ii++] = vertexId++
            indices[ii++] = vertexId++
        }

        // Travels rendered as a faint gray — visible enough to read
        // print-head movement, dim enough not to drown the extrusion
        // colors. They're still drawn as plain LINES; without
        // line-shader support there's no native way to dash them.
        val travelRgb = Rgb(0.30f, 0.30f, 0.32f)
        for (t in activeTravels) {
            positions[pi++] = t.start.x - cx
            positions[pi++] = t.start.y - cy
            positions[pi++] = t.start.z - cz
            positions[pi++] = t.end.x - cx
            positions[pi++] = t.end.y - cy
            positions[pi++] = t.end.z - cz
            colors[ci++] = travelRgb.r; colors[ci++] = travelRgb.g; colors[ci++] = travelRgb.b
            colors[ci++] = travelRgb.r; colors[ci++] = travelRgb.g; colors[ci++] = travelRgb.b
            indices[ii++] = vertexId++
            indices[ii++] = vertexId++
        }

        GlbBuilder(
            positions = positions,
            indices = indices,
            mode = GlbBuilder.MODE_LINES,
            colors = colors,
        ).writeTo(out)
    }

    /**
     * Parse a `#RRGGBB` (or bare `RRGGBB`) hex string into the [Rgb]
     * float-triplet RoleColors emits. Returns null on malformed input —
     * caller decides on a fallback (typically the role-based color so
     * the segment is still legible).
     */
    private fun hexToRgb(hex: String): Rgb? {
        val cleaned = hex.removePrefix("#").trim()
        if (cleaned.length != 6) return null
        return runCatching {
            val r = cleaned.substring(0, 2).toInt(16) / 255f
            val g = cleaned.substring(2, 4).toInt(16) / 255f
            val b = cleaned.substring(4, 6).toInt(16) / 255f
            Rgb(r, g, b)
        }.getOrNull()
    }
}
