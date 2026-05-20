package dev.orcaxr.app

import java.io.File
import kotlin.math.abs
import kotlin.math.sqrt

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
    /** Roadmap A7 — historical tubes-mode segment cap. **Pre-streaming
     *  era**, materializing the full tube geometry for a 500k-segment
     *  dragon cost ~170 MB of JVM heap (positions + colors + indices),
     *  which OOMs Android at the typical 256 MB process cap. The
     *  array-allocation path was capped at 250K and silently fell
     *  back to LINES above that.
     *
     *  As of the streaming-tubes refactor (`GlbBuilder.streamGlb` +
     *  the chunked position/color/index writers below), the writer
     *  holds at most a 64 KB scratch buffer + a 12 MB per-segment
     *  natural-frame cache regardless of segment count. The cap is
     *  retained as a safety valve for pathological inputs (multi-
     *  million-segment slices that would still pressure the
     *  per-segment cache); it's set high enough that the typical
     *  500k-dragon slice keeps tubes mode and only the genuinely
     *  unreasonable cases drop to LINES. */
    const val TUBES_SEGMENT_CAP = 1_500_000

    /** Default tube radius in printer-frame units (mm). Slightly less
     *  than half a 0.4 mm extrusion so adjacent segments on the same
     *  layer don't z-fight when they share an endpoint. */
    const val DEFAULT_TUBE_RADIUS_MM = 0.18f

    /**
     * Roadmap A14 — color-mode selector for [write]. The default
     * [Auto] is the pre-A14 behavior (per-extruder when ≥2 tools, per-
     * role otherwise). [Extruder] forces the per-tool palette even on
     * single-tool slices (uniform-color rendering). [Feature] forces
     * the per-[ExtrusionRole] palette (outer wall = red, infill =
     * yellow, support = gray, …) even on multi-color slices — useful
     * for inspecting feature decomposition on a multi-tool job.
     *
     * The mode is consulted by `colorOf` inside [write]; tests pin the
     * three modes against a fixture toolpath in `ToolpathGlbColorModeTest`.
     */
    enum class ColorMode {
        Auto, Extruder, Feature;

        companion object {
            fun parse(name: String?): ColorMode = when (name?.lowercase()) {
                "extruder", "tool", "filament" -> Extruder
                "feature", "role", "type" -> Feature
                else -> Auto
            }
        }
    }

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
        /** Roadmap A14 — see [ColorMode]. Default [ColorMode.Auto]
         *  preserves the pre-A14 behavior so existing call sites
         *  don't change. */
        colorMode: ColorMode = ColorMode.Auto,
        /**
         * Roadmap A7 — when true, every extrusion segment renders as a
         * 4-sided rectangular prism (8 verts, 12 tris) instead of a
         * single LINE primitive. Closer to desktop OrcaSlicer's GL
         * viewer at the cost of ~6× triangle count vs LINES.
         *
         * Above [TUBES_SEGMENT_CAP] segments we silently fall back to
         * LINES; see the constant doc for the OOM rationale.
         *
         * Travel segments stay LINES even in tubes mode — they're
         * meant to read as auxiliary movement, not as deposited
         * material, so doubling-down on geometry mass is wasted budget.
         */
        tubes: Boolean = false,
        /** Tube cross-section radius in printer-frame mm. Ignored when [tubes] is false. */
        tubeRadiusMm: Float = DEFAULT_TUBE_RADIUS_MM,
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

        // Tubes mode is only viable for moderately-sized slices; above
        // the cap the JVM-side allocation for positions+colors+indices
        // would dwarf the typical Android process cap. Fall back to
        // LINES silently — the user-visible difference at that scale
        // (e.g. a 1.4M-tri dragon) is small anyway because individual
        // tubes are sub-pixel from a meter away.
        val useTubes = tubes && segs.size <= TUBES_SEGMENT_CAP

        val palette: List<Rgb> = extruderPalette
            ?.map { hexToRgb(it) ?: Rgb(0.6f, 0.6f, 0.6f) }
            .orEmpty()
        val distinctExtruders = segs.asSequence().map { it.extruder }.distinct().take(2).count()
        // Roadmap A14 — colorMode picks between three strategies:
        //   Auto     — per-extruder if ≥2 distinct tools AND a palette
        //              was supplied; otherwise per-role.
        //   Extruder — force per-tool. Falls back to role only if no
        //              palette / single-tool slice (otherwise every
        //              segment would render mid-gray).
        //   Feature  — force per-role. Useful for inspecting feature
        //              decomposition on a multi-color slice.
        val byExtruder: Boolean = when (colorMode) {
            ColorMode.Feature -> false
            ColorMode.Extruder -> !extruderPalette.isNullOrEmpty()
            ColorMode.Auto -> distinctExtruders >= 2 && !extruderPalette.isNullOrEmpty()
        }
        val zRange = (toolpath.stats.bboxMax.z - toolpath.stats.bboxMin.z).coerceAtLeast(1e-3f)

        // Two coloring strategies, shared by tubes + lines:
        //  - byExtruder: color each segment by its tool index via
        //    [extruderPalette], matching the slot swatches in
        //    LeftProjectPanel.
        //  - else: color by extrusion role (outer wall = red, infill =
        //    yellow, support = gray — see RoleColors). When role is
        //    Unknown (G-code skipped `;TYPE:` tagging) we fall through
        //    to a Z-based gradient so the toolpath still reads as a
        //    height map.
        fun colorOf(s: ExtrusionSegment): Rgb = when {
            byExtruder -> palette.getOrNull(s.extruder.coerceAtLeast(0) % palette.size.coerceAtLeast(1))
                ?: RoleColors.colorFor(s.role)
            s.role == ExtrusionRole.Unknown -> {
                val t = ((s.z - toolpath.stats.bboxMin.z) / zRange).coerceIn(0f, 1f)
                Rgb(1.0f - t, 1.0f - kotlin.math.abs(t - 0.5f) * 2.0f, t)
            }
            else -> RoleColors.colorFor(s.role)
        }

        val travelRgb = Rgb(0.30f, 0.30f, 0.32f)

        if (useTubes) {
            writeTubes(
                segs = segs,
                travels = activeTravels,
                cx = cx, cy = cy, cz = cz,
                radius = tubeRadiusMm,
                colorOf = ::colorOf,
                travelRgb = travelRgb,
                out = out,
            )
            return
        }

        val positions = FloatArray(totalSegs * 6)
        val colors = FloatArray(totalSegs * 6)
        val indices = IntArray(totalSegs * 2)

        var pi = 0; var ci = 0; var ii = 0
        var vertexId = 0
        for (s in segs) {
            val rgb = colorOf(s)

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
     * Roadmap A7 — emit each extrusion segment as a 4-sided rectangular
     * prism (8 verts, 12 tris, 36 indices). **Streaming**: positions /
     * colors / indices are written through `GlbBuilder.streamGlb`'s
     * 64 KB scratch buffer so a 500k-segment slice doesn't OOM at the
     * 256 MB Android process cap.
     *
     * **Mitered joins**: when consecutive segments share an endpoint
     * (the canonical "single continuous toolpath" case), the join's
     * cross-section uses the average of the two segments' natural
     * side/up axes plus a `1/cos(angle/2)` width compensation so the
     * apparent extrusion radius stays constant through the corner.
     * Travels and chain breaks (different layer, tool change, retract)
     * fall back to per-segment perpendicular cross-sections.
     *
     * Per-prism natural cross-section is built by:
     *   1. tangent t = normalize(end − start);
     *   2. ref = world-Z (or world-Y if t is nearly Z-aligned);
     *   3. side = normalize(cross(t, ref)) — points "right" of t;
     *   4. up   = normalize(cross(side, t)) — points "up" relative to t.
     * The 4 cross-section corners are start ± r*side ± r*up at each
     * end. CCW winding for outward-facing normals.
     *
     * Travels stay LINES — they're auxiliary, and doubling-down on
     * geometry mass for them is wasted budget at the scale we're
     * rendering.
     */
    private fun writeTubes(
        segs: List<ExtrusionSegment>,
        travels: List<TravelSegment>,
        cx: Float, cy: Float, cz: Float,
        radius: Float,
        colorOf: (ExtrusionSegment) -> Rgb,
        travelRgb: Rgb,
        out: File,
    ) {
        val n = segs.size
        if (n == 0 && travels.isEmpty()) return

        // Per-segment natural-frame cache. 6 floats per segment
        // (sxn,syn,szn, uxn,uyn,uzn). 12 MB at 500k segs — versus the
        // pre-A7-streaming 170 MB allocation for the full
        // positions+colors+indices arrays. Computed in one linear
        // pass so no random-access reads later in the writer.
        val frames = FloatArray(n * 6)
        // Per-segment unit tangent cache (3 floats × n) for the
        // miter bisector calculation. 6 MB at 500k. Reused by the
        // index writer to detect connectivity.
        val tangents = FloatArray(n * 3)

        var bxMin = Float.POSITIVE_INFINITY
        var byMin = Float.POSITIVE_INFINITY
        var bzMin = Float.POSITIVE_INFINITY
        var bxMax = Float.NEGATIVE_INFINITY
        var byMax = Float.NEGATIVE_INFINITY
        var bzMax = Float.NEGATIVE_INFINITY

        for (i in 0 until n) {
            val s = segs[i]
            val sx = s.start.x - cx; val sy = s.start.y - cy; val sz = s.start.z - cz
            val ex = s.end.x - cx;   val ey = s.end.y - cy;   val ez = s.end.z - cz
            // Track centerline bbox; we'll inflate by `radius` once at
            // the end so the GLB accessor's min/max covers the prism
            // corners exactly.
            if (sx < bxMin) bxMin = sx; if (sx > bxMax) bxMax = sx
            if (sy < byMin) byMin = sy; if (sy > byMax) byMax = sy
            if (sz < bzMin) bzMin = sz; if (sz > bzMax) bzMax = sz
            if (ex < bxMin) bxMin = ex; if (ex > bxMax) bxMax = ex
            if (ey < byMin) byMin = ey; if (ey > byMax) byMax = ey
            if (ez < bzMin) bzMin = ez; if (ez > bzMax) bzMax = ez

            val tx = ex - sx; val ty = ey - sy; val tz = ez - sz
            val tlen = sqrt(tx * tx + ty * ty + tz * tz)
            if (tlen < 1e-5f) {
                // Degenerate; use an X-axis tangent so the frame is
                // well-defined. The position-emit pass will detect the
                // zero length and emit a tiny axis-aligned box.
                tangents[i * 3 + 0] = 1f
                tangents[i * 3 + 1] = 0f
                tangents[i * 3 + 2] = 0f
                frames[i * 6 + 0] = 0f; frames[i * 6 + 1] = 1f; frames[i * 6 + 2] = 0f
                frames[i * 6 + 3] = 0f; frames[i * 6 + 4] = 0f; frames[i * 6 + 5] = 1f
                continue
            }
            val tnx = tx / tlen; val tny = ty / tlen; val tnz = tz / tlen
            tangents[i * 3 + 0] = tnx
            tangents[i * 3 + 1] = tny
            tangents[i * 3 + 2] = tnz
            // Reference axis: world-Z, unless tangent is nearly
            // Z-aligned (vertical extrusion → ill-conditioned cross),
            // in which case use world-Y.
            val useY = abs(tnz) > 0.95f
            val rx = 0f; val ry = if (useY) 1f else 0f; val rz = if (useY) 0f else 1f
            // side = normalize(cross(t, ref))
            var sxn = tny * rz - tnz * ry
            var syn = tnz * rx - tnx * rz
            var szn = tnx * ry - tny * rx
            var slen = sqrt(sxn * sxn + syn * syn + szn * szn)
            if (slen < 1e-6f) {
                sxn = 1f; syn = 0f; szn = 0f; slen = 1f
            }
            sxn /= slen; syn /= slen; szn /= slen
            // up = normalize(cross(side, t))
            var uxn = syn * tnz - szn * tny
            var uyn = szn * tnx - sxn * tnz
            var uzn = sxn * tny - syn * tnx
            val ulen = sqrt(uxn * uxn + uyn * uyn + uzn * uzn).coerceAtLeast(1e-9f)
            uxn /= ulen; uyn /= ulen; uzn /= ulen
            frames[i * 6 + 0] = sxn; frames[i * 6 + 1] = syn; frames[i * 6 + 2] = szn
            frames[i * 6 + 3] = uxn; frames[i * 6 + 4] = uyn; frames[i * 6 + 5] = uzn
        }

        // Inflate centerline bbox by radius for the GLB accessor min/max.
        // Travels stay inside this envelope (they have zero radius).
        val tubeVerts = n * 8
        val travelVerts = travels.size * 2
        val totalVerts = tubeVerts + travelVerts
        val totalIndices = n * 36 + travels.size * 3
        if (totalVerts == 0 || totalIndices == 0) return
        val bboxMin = floatArrayOf(bxMin - radius, byMin - radius, bzMin - radius)
        val bboxMax = floatArrayOf(bxMax + radius, byMax + radius, bzMax + radius)

        // Connectivity helper — true if seg[i].end ≈ seg[i+1].start
        // (single continuous toolpath). 1e-3 mm tolerance.
        fun connectedToNext(i: Int): Boolean {
            if (i + 1 >= n) return false
            val a = segs[i]; val b = segs[i + 1]
            val dx = a.end.x - b.start.x
            val dy = a.end.y - b.start.y
            val dz = a.end.z - b.start.z
            return dx * dx + dy * dy + dz * dz < 1e-6f
        }

        GlbBuilder.streamGlb(
            out = out,
            vertexCount = totalVerts,
            indexCount = totalIndices,
            mode = GlbBuilder.MODE_TRIANGLES,
            bboxMin = bboxMin,
            bboxMax = bboxMax,
            hasColors = true,
            doubleSided = true,
            writePositions = { sink ->
                for (i in 0 until n) {
                    emitTubePositions(
                        sink, segs, i, frames, tangents,
                        cx = cx, cy = cy, cz = cz, radius = radius,
                        prevConnected = i > 0 && connectedToNext(i - 1),
                        nextConnected = connectedToNext(i),
                    )
                }
                for (t in travels) {
                    sink.write(t.start.x - cx, t.start.y - cy, t.start.z - cz)
                    sink.write(t.end.x - cx,   t.end.y - cy,   t.end.z - cz)
                }
            },
            writeColors = { sink ->
                for (i in 0 until n) {
                    val rgb = colorOf(segs[i])
                    val sxn = frames[i * 6 + 0]; val syn = frames[i * 6 + 1]; val szn = frames[i * 6 + 2]
                    val uxn = frames[i * 6 + 3]; val uyn = frames[i * 6 + 4]; val uzn = frames[i * 6 + 5]
                    val tnx = tangents[i * 3 + 0]; val tny = tangents[i * 3 + 1]; val tnz = tangents[i * 3 + 2]
                    // Same 8-corner sign pattern as before; recompute
                    // the per-corner outward normal and Lambert factor
                    // here so the streaming pass doesn't need a
                    // pre-cached colors array.
                    val cornerSigns = CORNER_SIGNS
                    for (v in 0 until 8) {
                        val ssgn = cornerSigns[v * 3 + 0].toFloat()
                        val usgn = cornerSigns[v * 3 + 1].toFloat()
                        val tsgn = cornerSigns[v * 3 + 2].toFloat()
                        var nxw = ssgn * sxn + usgn * uxn + tsgn * tnx
                        var nyw = ssgn * syn + usgn * uyn + tsgn * tny
                        var nzw = ssgn * szn + usgn * uzn + tsgn * tnz
                        val nlen = sqrt(nxw * nxw + nyw * nyw + nzw * nzw).coerceAtLeast(1e-9f)
                        nxw /= nlen; nyw /= nlen; nzw /= nlen
                        val shade = lambertFactor(nxw, nyw, nzw)
                        sink.write(rgb.r * shade, rgb.g * shade, rgb.b * shade)
                    }
                }
                for (@Suppress("UNUSED_VARIABLE") t in travels) {
                    sink.write(travelRgb.r, travelRgb.g, travelRgb.b)
                    sink.write(travelRgb.r, travelRgb.g, travelRgb.b)
                }
            },
            writeIndices = { sink ->
                var baseId = 0
                for (i in 0 until n) {
                    for (idx in TUBE_FACES) sink.write(baseId + idx)
                    baseId += 8
                }
                // Travel hairlines (degenerate triangles).
                for (@Suppress("UNUSED_VARIABLE") t in travels) {
                    sink.write(baseId)
                    sink.write(baseId + 1)
                    sink.write(baseId + 1)
                    baseId += 2
                }
            },
        )
        return // streaming path replaces the legacy array-build below
    }

    /**
     * Emit the 8 prism corners for segment [i] through [sink].
     * Joins are mitered when the segment connects to its predecessor
     * (or successor) — the corresponding cross-section uses the
     * average of the two segments' natural side/up axes plus a
     * `1/cos(angle/2)` width compensation.
     */
    private fun emitTubePositions(
        sink: FloatSink,
        segs: List<ExtrusionSegment>,
        i: Int,
        frames: FloatArray,
        tangents: FloatArray,
        cx: Float, cy: Float, cz: Float,
        radius: Float,
        prevConnected: Boolean,
        nextConnected: Boolean,
    ) {
        val s = segs[i]
        val sx = s.start.x - cx; val sy = s.start.y - cy; val sz = s.start.z - cz
        val ex = s.end.x - cx;   val ey = s.end.y - cy;   val ez = s.end.z - cz

        val tx = ex - sx; val ty = ey - sy; val tz = ez - sz
        val tlen = sqrt(tx * tx + ty * ty + tz * tz)
        if (tlen < 1e-5f) {
            // Degenerate; emit a tiny X-axis-aligned box centered at
            // start so the vertex count per segment stays 8.
            val r = radius
            // 8 corners of a box (-r..+r) × (-r..+r) × (0..+0.001)
            // around (sx, sy, sz). Layout matches CORNER_SIGNS.
            sink.write(sx - r, sy - r, sz - r)
            sink.write(sx + r, sy - r, sz - r)
            sink.write(sx + r, sy + r, sz - r)
            sink.write(sx - r, sy + r, sz - r)
            sink.write(sx - r, sy - r, sz + r)
            sink.write(sx + r, sy - r, sz + r)
            sink.write(sx + r, sy + r, sz + r)
            sink.write(sx - r, sy + r, sz + r)
            return
        }

        // Read this segment's natural frame.
        val sxn = frames[i * 6 + 0]; val syn = frames[i * 6 + 1]; val szn = frames[i * 6 + 2]
        val uxn = frames[i * 6 + 3]; val uyn = frames[i * 6 + 4]; val uzn = frames[i * 6 + 5]
        val tnx = tangents[i * 3 + 0]; val tny = tangents[i * 3 + 1]; val tnz = tangents[i * 3 + 2]

        // Start-side frame: average with predecessor when connected.
        var sStartX = sxn; var sStartY = syn; var sStartZ = szn
        var uStartX = uxn; var uStartY = uyn; var uStartZ = uzn
        var startScale = 1f
        if (prevConnected) {
            val pIdx = i - 1
            val pSx = frames[pIdx * 6 + 0]; val pSy = frames[pIdx * 6 + 1]; val pSz = frames[pIdx * 6 + 2]
            val pUx = frames[pIdx * 6 + 3]; val pUy = frames[pIdx * 6 + 4]; val pUz = frames[pIdx * 6 + 5]
            val pTx = tangents[pIdx * 3 + 0]; val pTy = tangents[pIdx * 3 + 1]; val pTz = tangents[pIdx * 3 + 2]
            // Average + renormalize for the cross-section axes.
            sStartX = sxn + pSx; sStartY = syn + pSy; sStartZ = szn + pSz
            val sLen = sqrt(sStartX * sStartX + sStartY * sStartY + sStartZ * sStartZ)
                .coerceAtLeast(1e-9f)
            sStartX /= sLen; sStartY /= sLen; sStartZ /= sLen
            uStartX = uxn + pUx; uStartY = uyn + pUy; uStartZ = uzn + pUz
            val uLen = sqrt(uStartX * uStartX + uStartY * uStartY + uStartZ * uStartZ)
                .coerceAtLeast(1e-9f)
            uStartX /= uLen; uStartY /= uLen; uStartZ /= uLen
            // Width compensation: 1/cos(half-angle). Cap at 4× for
            // near-180° reversals (would otherwise produce huge
            // miter spikes).
            val tDot = (tnx * pTx + tny * pTy + tnz * pTz).coerceIn(-1f, 1f)
            val cosHalf = sqrt(((1f + tDot) * 0.5f).coerceAtLeast(1e-4f))
            startScale = (1f / cosHalf).coerceAtMost(4f)
        }

        // End-side frame: average with successor when connected.
        var sEndX = sxn; var sEndY = syn; var sEndZ = szn
        var uEndX = uxn; var uEndY = uyn; var uEndZ = uzn
        var endScale = 1f
        if (nextConnected) {
            val nIdx = i + 1
            val nSx = frames[nIdx * 6 + 0]; val nSy = frames[nIdx * 6 + 1]; val nSz = frames[nIdx * 6 + 2]
            val nUx = frames[nIdx * 6 + 3]; val nUy = frames[nIdx * 6 + 4]; val nUz = frames[nIdx * 6 + 5]
            val nTx = tangents[nIdx * 3 + 0]; val nTy = tangents[nIdx * 3 + 1]; val nTz = tangents[nIdx * 3 + 2]
            sEndX = sxn + nSx; sEndY = syn + nSy; sEndZ = szn + nSz
            val sLen = sqrt(sEndX * sEndX + sEndY * sEndY + sEndZ * sEndZ).coerceAtLeast(1e-9f)
            sEndX /= sLen; sEndY /= sLen; sEndZ /= sLen
            uEndX = uxn + nUx; uEndY = uyn + nUy; uEndZ = uzn + nUz
            val uLen = sqrt(uEndX * uEndX + uEndY * uEndY + uEndZ * uEndZ).coerceAtLeast(1e-9f)
            uEndX /= uLen; uEndY /= uLen; uEndZ /= uLen
            val tDot = (tnx * nTx + tny * nTy + tnz * nTz).coerceIn(-1f, 1f)
            val cosHalf = sqrt(((1f + tDot) * 0.5f).coerceAtLeast(1e-4f))
            endScale = (1f / cosHalf).coerceAtMost(4f)
        }

        val rs = radius * startScale
        val re = radius * endScale

        // 4 vertices at start using the start frame:
        //   v0: start − rs*side − rs*up
        //   v1: start + rs*side − rs*up
        //   v2: start + rs*side + rs*up
        //   v3: start − rs*side + rs*up
        sink.write(
            sx - rs * sStartX - rs * uStartX,
            sy - rs * sStartY - rs * uStartY,
            sz - rs * sStartZ - rs * uStartZ,
        )
        sink.write(
            sx + rs * sStartX - rs * uStartX,
            sy + rs * sStartY - rs * uStartY,
            sz + rs * sStartZ - rs * uStartZ,
        )
        sink.write(
            sx + rs * sStartX + rs * uStartX,
            sy + rs * sStartY + rs * uStartY,
            sz + rs * sStartZ + rs * uStartZ,
        )
        sink.write(
            sx - rs * sStartX + rs * uStartX,
            sy - rs * sStartY + rs * uStartY,
            sz - rs * sStartZ + rs * uStartZ,
        )
        // 4 vertices at end using the end frame:
        sink.write(
            ex - re * sEndX - re * uEndX,
            ey - re * sEndY - re * uEndY,
            ez - re * sEndZ - re * uEndZ,
        )
        sink.write(
            ex + re * sEndX - re * uEndX,
            ey + re * sEndY - re * uEndY,
            ez + re * sEndZ - re * uEndZ,
        )
        sink.write(
            ex + re * sEndX + re * uEndX,
            ey + re * sEndY + re * uEndY,
            ez + re * sEndZ + re * uEndZ,
        )
        sink.write(
            ex - re * sEndX + re * uEndX,
            ey - re * sEndY + re * uEndY,
            ez - re * sEndZ + re * uEndZ,
        )
    }

    /** Per-corner sign pattern matching the v0..v7 prism layout. Used
     *  by the color-write pass to compute outward normals for Lambert
     *  shading without a pre-cached `cornerSigns` array per segment. */
    private val CORNER_SIGNS: IntArray = intArrayOf(
        -1, -1, -1,  // v0
         1, -1, -1,  // v1
         1,  1, -1,  // v2
        -1,  1, -1,  // v3
        -1, -1,  1,  // v4
         1, -1,  1,  // v5
         1,  1,  1,  // v6
        -1,  1,  1,  // v7
    )

    /** 12 triangles × 3 indices = 36, CCW outward. v0..3 = start, v4..7 = end. */
    private val TUBE_FACES: IntArray = intArrayOf(
        // back cap (start) — points along −t
        0, 2, 1,  0, 3, 2,
        // front cap (end) — points along +t
        4, 5, 6,  4, 6, 7,
        // −up face (v0, v1, v5, v4)
        0, 1, 5,  0, 5, 4,
        // +up face (v3, v7, v6, v2)
        3, 7, 6,  3, 6, 2,
        // −side face (v0, v4, v7, v3)
        0, 4, 7,  0, 7, 3,
        // +side face (v1, v2, v6, v5)
        1, 2, 6,  1, 6, 5,
    )

    /** Legacy (pre-streaming) tube writer kept for reference; the
     *  streaming path above replaces it on the live render path. The
     *  body below is unreachable but retained inside the same function
     *  to minimize blast radius if the streaming refactor needs to be
     *  reverted. Compiler-DCE will trim it. */
    @Suppress("UNUSED_PARAMETER", "unused")
    private fun writeTubesLegacy(
        segs: List<ExtrusionSegment>,
        travels: List<TravelSegment>,
        cx: Float, cy: Float, cz: Float,
        radius: Float,
        colorOf: (ExtrusionSegment) -> Rgb,
        travelRgb: Rgb,
        out: File,
    ) {
        val tubeVerts = segs.size * 8
        val tubeTris = segs.size * 12
        val travelVerts = travels.size * 2

        val positions = FloatArray((tubeVerts + travelVerts) * 3)
        val colors = FloatArray((tubeVerts + travelVerts) * 3)
        // Tubes use TRIANGLES (3 indices per tri); travels use LINES
        // (2 indices per seg). We can't mix primitive modes inside a
        // single primitive — so emit both in a single TRIANGLES
        // primitive by representing each travel as a degenerate-thin
        // triangle (start, end, end). This keeps one draw call without
        // a multi-primitive mesh, at the cost of a 0-area triangle per
        // travel. The renderer rasterizes it as a 1-pixel-wide hairline
        // — close enough to the historical LINES behavior for the
        // user's purpose.
        val indices = IntArray(tubeTris * 3 + travels.size * 3)

        var pi = 0; var ci = 0; var ii = 0
        var vertexId = 0

        for (s in segs) {
            val rgb = colorOf(s)
            val sx = s.start.x - cx; val sy = s.start.y - cy; val sz = s.start.z - cz
            val ex = s.end.x - cx;   val ey = s.end.y - cy;   val ez = s.end.z - cz
            val tx = ex - sx; val ty = ey - sy; val tz = ez - sz
            val tlen = sqrt(tx * tx + ty * ty + tz * tz)
            if (tlen < 1e-5f) {
                // Degenerate (start ≈ end) — emit a tiny X-aligned box
                // so the index/vertex counts stay invariant. The user
                // wouldn't see this segment at any reasonable zoom.
                appendBox(
                    positions, colors, indices, vertexId, pi, ci, ii,
                    sx, sy, sz, sx + 0.001f, sy, sz, radius, rgb,
                )
                pi += 24; ci += 24; ii += 36; vertexId += 8
                continue
            }
            val tnx = tx / tlen; val tny = ty / tlen; val tnz = tz / tlen
            // Reference axis: world-Z, unless tangent is nearly
            // Z-aligned (vertical extrusion → ill-conditioned cross),
            // in which case use world-Y. A 0.95-cosine threshold keeps
            // the cross product well-conditioned (sin>0.31).
            val useY = abs(tnz) > 0.95f
            val rx = 0f; val ry = if (useY) 1f else 0f; val rz = if (useY) 0f else 1f
            // side = normalize(cross(t, ref))
            var sxn = tny * rz - tnz * ry
            var syn = tnz * rx - tnx * rz
            var szn = tnx * ry - tny * rx
            var slen = sqrt(sxn * sxn + syn * syn + szn * szn)
            if (slen < 1e-6f) {
                // Should not happen given the useY guard, but defensively
                // pick an axis-aligned side.
                sxn = 1f; syn = 0f; szn = 0f; slen = 1f
            }
            sxn /= slen; syn /= slen; szn /= slen
            // up = normalize(cross(side, t)); already unit since
            // side ⊥ t are unit vectors but normalize defensively.
            var uxn = syn * tnz - szn * tny
            var uyn = szn * tnx - sxn * tnz
            var uzn = sxn * tny - syn * tnx
            val ulen = sqrt(uxn * uxn + uyn * uyn + uzn * uzn).coerceAtLeast(1e-9f)
            uxn /= ulen; uyn /= ulen; uzn /= ulen

            val baseId = vertexId

            // 4 vertices at start (CCW seen from −t):
            //   v0: start − r*side − r*up  (back-bottom-left)
            //   v1: start + r*side − r*up  (back-bottom-right)
            //   v2: start + r*side + r*up  (back-top-right)
            //   v3: start − r*side + r*up  (back-top-left)
            // 4 at end:
            //   v4..v7 same offsets at end.
            val pts = floatArrayOf(
                sx - radius * sxn - radius * uxn, sy - radius * syn - radius * uyn, sz - radius * szn - radius * uzn,
                sx + radius * sxn - radius * uxn, sy + radius * syn - radius * uyn, sz + radius * szn - radius * uzn,
                sx + radius * sxn + radius * uxn, sy + radius * syn + radius * uyn, sz + radius * szn + radius * uzn,
                sx - radius * sxn + radius * uxn, sy - radius * syn + radius * uyn, sz - radius * szn + radius * uzn,
                ex - radius * sxn - radius * uxn, ey - radius * syn - radius * uyn, ez - radius * szn - radius * uzn,
                ex + radius * sxn - radius * uxn, ey + radius * syn - radius * uyn, ez + radius * szn - radius * uzn,
                ex + radius * sxn + radius * uxn, ey + radius * syn + radius * uyn, ez + radius * szn + radius * uzn,
                ex - radius * sxn + radius * uxn, ey - radius * syn + radius * uyn, ez - radius * szn + radius * uzn,
            )
            // Per-corner outward normals — each prism corner sits at the
            // intersection of three faces (one cap, two side faces), so
            // the outward direction is the normalized sum of those three
            // face normals: ±side, ±up, ±t. Pre-baked here as 8 sign
            // patterns matching the v0..v7 layout above. Lambert(n) is
            // then multiplied straight into the role/extruder color so
            // the unlit material (KHR_materials_unlit, set by GlbBuilder)
            // renders the shading on Galaxy XR — Jetpack XR SceneCore
            // doesn't ship a default scene light for PBR to sample.
            val cornerSigns = intArrayOf(
                -1, -1, -1,  // v0
                 1, -1, -1,  // v1
                 1,  1, -1,  // v2
                -1,  1, -1,  // v3
                -1, -1,  1,  // v4
                 1, -1,  1,  // v5
                 1,  1,  1,  // v6
                -1,  1,  1,  // v7
            )
            for (v in 0 until 8) {
                positions[pi++] = pts[v * 3]
                positions[pi++] = pts[v * 3 + 1]
                positions[pi++] = pts[v * 3 + 2]
                val ssgn = cornerSigns[v * 3 + 0]
                val usgn = cornerSigns[v * 3 + 1]
                val tsgn = cornerSigns[v * 3 + 2]
                var nxw = ssgn * sxn + usgn * uxn + tsgn * tnx
                var nyw = ssgn * syn + usgn * uyn + tsgn * tny
                var nzw = ssgn * szn + usgn * uzn + tsgn * tnz
                val nlen = sqrt(nxw * nxw + nyw * nyw + nzw * nzw).coerceAtLeast(1e-9f)
                nxw /= nlen; nyw /= nlen; nzw /= nlen
                val shade = lambertFactor(nxw, nyw, nzw)
                colors[ci++] = rgb.r * shade
                colors[ci++] = rgb.g * shade
                colors[ci++] = rgb.b * shade
            }
            // 12 triangles, CCW outward. v0..3 = start ring, v4..7 = end ring.
            // Back cap (start, looking along −t):  0,2,1 / 0,3,2
            // Front cap (end, looking along +t):   4,5,6 / 4,6,7
            // -side face (v0,v3,v7,v4):            0,4,7 / 0,7,3   — wait, careful with winding
            // Use the same convention as the refactored `SelectionBboxEntity` where
            // (xmin,ymin,zmin)=v0 etc. Adapted:
            val faces = intArrayOf(
                // back cap (start) — points along −t
                0, 2, 1, 0, 3, 2,
                // front cap (end) — points along +t
                4, 5, 6, 4, 6, 7,
                // −up face (v0, v1, v5, v4)
                0, 1, 5, 0, 5, 4,
                // +up face (v3, v7, v6, v2)
                3, 7, 6, 3, 6, 2,
                // −side face (v0, v4, v7, v3)
                0, 4, 7, 0, 7, 3,
                // +side face (v1, v2, v6, v5)
                1, 2, 6, 1, 6, 5,
            )
            for (idx in faces) indices[ii++] = baseId + idx
            vertexId += 8
        }

        // Travel hairline triangles. Each travel is a degenerate
        // triangle (start, end, end) — same hairline aesthetic as the
        // pure-LINES branch.
        for (t in travels) {
            val baseId = vertexId
            positions[pi++] = t.start.x - cx; positions[pi++] = t.start.y - cy; positions[pi++] = t.start.z - cz
            positions[pi++] = t.end.x - cx;   positions[pi++] = t.end.y - cy;   positions[pi++] = t.end.z - cz
            colors[ci++] = travelRgb.r; colors[ci++] = travelRgb.g; colors[ci++] = travelRgb.b
            colors[ci++] = travelRgb.r; colors[ci++] = travelRgb.g; colors[ci++] = travelRgb.b
            indices[ii++] = baseId; indices[ii++] = baseId + 1; indices[ii++] = baseId + 1
            vertexId += 2
        }

        GlbBuilder(
            positions = positions,
            indices = indices,
            mode = GlbBuilder.MODE_TRIANGLES,
            colors = colors,
            doubleSided = true,
        ).writeTo(out)
    }

    /**
     * Two-light Lambert factor for the unlit-material vertex-color
     * baking path. Light directions match the model preview baker in
     * `slic3r_jni.cpp::nativeWriteColoredGlb` so the post-slice
     * toolpath shading reads as the same scene the prepare-mode
     * model is lit by. [n] is expected to be unit length.
     */
    private fun lambertFactor(nx: Float, ny: Float, nz: Float): Float {
        val keyDot = nx * 0.40f + ny * 0.30f + nz * 0.866f
        val fillDot = nx * -0.30f + ny * -0.50f + nz * -0.812f
        val key = if (keyDot > 0f) keyDot else 0f
        val fill = if (fillDot > 0f) fillDot else 0f
        val shade = 0.32f + 0.55f * key + 0.18f * fill
        return if (shade > 1f) 1f else shade
    }

    /**
     * Helper for the tubes degenerate-segment path — emit an axis-
     * aligned box of [size] cube around the start point so the
     * vertex/index counts per segment stay 8/36 even when the segment
     * is zero-length. Caller writes through the same shared
     * positions/colors/indices arrays via the offsets.
     */
    @Suppress("UNUSED_PARAMETER")
    private fun appendBox(
        positions: FloatArray,
        colors: FloatArray,
        indices: IntArray,
        baseId: Int,
        pi0: Int, ci0: Int, ii0: Int,
        ax: Float, ay: Float, az: Float,
        bx: Float, by: Float, bz: Float,
        radius: Float,
        rgb: Rgb,
    ) {
        val r = radius
        val pts = floatArrayOf(
            ax - r, ay - r, az - r,
            ax + r, ay - r, az - r,
            ax + r, ay + r, az - r,
            ax - r, ay + r, az - r,
            bx - r, by - r, bz + r,
            bx + r, by - r, bz + r,
            bx + r, by + r, bz + r,
            bx - r, by + r, bz + r,
        )
        var p = pi0; var c = ci0
        for (v in 0 until 8) {
            positions[p++] = pts[v * 3]
            positions[p++] = pts[v * 3 + 1]
            positions[p++] = pts[v * 3 + 2]
            colors[c++] = rgb.r; colors[c++] = rgb.g; colors[c++] = rgb.b
        }
        val faces = intArrayOf(
            0, 2, 1, 0, 3, 2,
            4, 5, 6, 4, 6, 7,
            0, 1, 5, 0, 5, 4,
            3, 7, 6, 3, 6, 2,
            0, 4, 7, 0, 7, 3,
            1, 2, 6, 1, 6, 5,
        )
        var i = ii0
        for (idx in faces) indices[i++] = baseId + idx
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
