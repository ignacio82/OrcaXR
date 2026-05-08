package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiMaskProjection
import dev.orcaxr.app.AiProceduralPaint
import dev.orcaxr.app.AiRenderEngine
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.Vec3f
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject

/**
 * AI paint pillar — Milestone 6 advanced primitives:
 *   - `paint_gradient`: per-axis or per-direction procedural gradient,
 *     quantized to a list of filament-slot stops.
 *   - `paint_noise`: deterministic 3D value noise quantized to stops.
 *   - `paint_frustum`: rectangular 2D-bbox selection. Picks every
 *     triangle whose centroid projects inside the bbox AND faces the
 *     camera. Cheap and reliable LLM authoring shape — the LLM
 *     supplies (camera, x1, y1, x2, y2) instead of a polygon mask.
 *
 * All three share the established AiPaintTools plumbing:
 * [AiPaintTools.preflight] → [AiPaintTools.Plan] → [AiPaintTools.emitAndRespond]
 * so paint history, sessions, merge filtering, and content-version
 * bumping behave identically to the existing primitives.
 *
 * Procedural tools may emit ONE [WorkspaceAction.PaintTriangleSet] per
 * stop, so a 3-stop gradient lands as 3 paint_undo entries on the live
 * path. Open a paint session if you want a single undo step covering
 * the whole gradient — `commit_paint_session` collapses the chain.
 */
internal object AiAdvancedPaintTools {

    fun all(ws: WorkspaceModel): List<Tool> = listOf(
        PaintGradient(ws),
        PaintNoise(ws),
        PaintFrustum(ws),
    )

    // ---- shared helpers ----

    private fun JSONObject.optFloat(key: String): Float? {
        if (!has(key)) return null
        val v = opt(key)
        return when (v) {
            is Number -> v.toFloat()
            is String -> v.toFloatOrNull()
            else -> null
        }
    }

    private fun parseStops(arr: JSONArray): Pair<List<AiProceduralPaint.Stop>, String?> {
        if (arr.length() == 0) return emptyList<AiProceduralPaint.Stop>() to "stops must be non-empty"
        val out = ArrayList<AiProceduralPaint.Stop>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i)
                ?: return emptyList<AiProceduralPaint.Stop>() to "stops[$i] must be an object"
            val tLo = (o.opt("t_lo") as? Number)?.toFloat()
                ?: return emptyList<AiProceduralPaint.Stop>() to "stops[$i].t_lo missing"
            val tHi = (o.opt("t_hi") as? Number)?.toFloat()
                ?: return emptyList<AiProceduralPaint.Stop>() to "stops[$i].t_hi missing"
            val tag = o.opt("tag")
            val tagInt = when (tag) {
                is Number -> tag.toInt()
                else -> return emptyList<AiProceduralPaint.Stop>() to "stops[$i].tag must be an integer"
            }
            if (!(tLo in 0f..1f && tHi in 0f..1f && tLo < tHi)) {
                return emptyList<AiProceduralPaint.Stop>() to
                    "stops[$i] requires 0 ≤ t_lo < t_hi ≤ 1; got [$tLo, $tHi]"
            }
            out.add(AiProceduralPaint.Stop(tLo, tHi, tagInt))
        }
        return out to null
    }

    /** Apply a procedural distribution: for each stop, route the
     *  resulting triangle set through the same plan/emit plumbing as
     *  every other paint tool. The plan's `tag` is overridden per
     *  stop; everything else (kind / merge / where_tag / session)
     *  carries through. Returns one ToolResult covering all stops. */
    private suspend fun emitProceduralStops(
        ws: WorkspaceModel,
        plan: AiPaintTools.Plan,
        stops: List<AiProceduralPaint.Stop>,
        bucketsPerStop: List<IntArray>,
        humanLabel: String,
        extraBase: JSONObject,
        returnIndices: Boolean,
    ): ToolResult {
        val perStopBodies = JSONArray()
        var totalMatched = 0
        var totalPainted = 0
        for ((stopIdx, stop) in stops.withIndex()) {
            val candidates = bucketsPerStop[stopIdx]
            if (candidates.isEmpty()) {
                perStopBodies.put(JSONObject().apply {
                    put("stop_index", stopIdx)
                    put("t_lo", stop.tLo.toDouble())
                    put("t_hi", stop.tHi.toDouble())
                    put("tag", stop.tag)
                    put("triangle_count", 0)
                    put("painted_count", 0)
                })
                continue
            }
            val perStopPlan = plan.copy(tag = stop.tag)
            val perStopExtra = JSONObject().apply {
                put("stop_index", stopIdx)
                put("t_lo", stop.tLo.toDouble())
                put("t_hi", stop.tHi.toDouble())
            }
            val r = AiPaintTools.emitAndRespond(
                ws = ws,
                plan = perStopPlan,
                candidates = candidates,
                humanLabel = "$humanLabel stop=$stopIdx tag=${stop.tag}",
                extra = perStopExtra,
                returnIndices = returnIndices,
            )
            val structured = r.structured
            if (structured != null) {
                perStopBodies.put(structured)
                totalMatched += structured.optInt("triangle_count", 0)
                totalPainted += structured.optInt("painted_count", 0)
            }
            if (r.isError) {
                // A mid-chain failure leaves earlier stops applied;
                // the LLM can paint_undo to roll back. Surface the
                // error verbatim so it can act on it.
                return r
            }
        }
        val body = JSONObject().apply {
            put("ok", true)
            put("model_id", plan.model.id)
            put("kind", plan.kind.name.lowercase())
            put("merge", plan.merge.name.lowercase())
            put("stop_count", stops.size)
            put("total_triangle_count_matched", totalMatched)
            put("total_painted_count", totalPainted)
            put("per_stop", perStopBodies)
            val keys = extraBase.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                put(k, extraBase.get(k))
            }
            plan.session?.let {
                put("session_id", it.id)
                put("session_version", it.version)
                put("session_total_actions", it.totalActions)
            }
        }
        val text = "$humanLabel — ${stops.size} stop(s), painted $totalPainted of $totalMatched matched tri(s)"
        return ToolResult.ok(text, body)
    }

    // ---- paint_gradient ----

    class PaintGradient(private val ws: WorkspaceModel) : Tool {
        override val name = "paint_gradient"
        override val description =
            "Procedural gradient paint: project every triangle's centroid onto a direction vector, " +
                "normalize against the model's bbox along that direction, and assign each triangle to " +
                "the first stop whose [t_lo, t_hi] band contains its `t`. axis='x'|'y'|'z' is the " +
                "shorthand; pass `direction:{x,y,z}` for an arbitrary direction. Stops are independent " +
                "filament-slot bands — leaving a gap (e.g. [0..0.3]→tag1, [0.7..1.0]→tag2 with no " +
                "stop covering 0.3..0.7) leaves the middle band untouched. Each stop emits one " +
                "PaintTriangleSet; open a paint_session for a single-undo result. Coords in centered_preview_mm."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "stops", "tag"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "kind" to Schemas.string("'color' (default) | 'support' | 'seam' | 'fuzzy_skin'"),
                "axis" to Schemas.string("'x' | 'y' | 'z' (shortcut for direction)"),
                "direction" to Schemas.obj(
                    properties = mapOf(
                        "x" to Schemas.number(""),
                        "y" to Schemas.number(""),
                        "z" to Schemas.number(""),
                    ),
                ),
                "stops" to JSONObject().apply {
                    put("type", "array")
                    put("description",
                        "Ordered list of {t_lo, t_hi, tag} — t in [0,1], 0 = bbox min along the direction, " +
                            "1 = bbox max. First-match wins on overlap. Tag is the filament slot to apply.",
                    )
                    put("items", Schemas.obj(
                        required = listOf("t_lo", "t_hi", "tag"),
                        properties = mapOf(
                            "t_lo" to Schemas.number("[0..1]"),
                            "t_hi" to Schemas.number("[0..1], > t_lo"),
                            "tag" to Schemas.integer("Filament slot 0..32"),
                        ),
                    ))
                },
                // Required by the shared preflight; validates kind range.
                // Even though stops carry their own tags, the preflight
                // expects a top-level `tag` to bound-check against the
                // kind's max — pass any one of your stop tags here.
                "tag" to Schemas.integer(
                    "Any one of your stop tags (used by preflight to bound-check against kind). " +
                        "The actual tag used per triangle comes from the stop it falls into.",
                ),
                "merge" to Schemas.string("'replace' (default) | 'only_unpainted' | 'only_tagged'"),
                "where_tag" to Schemas.integer("Required when merge='only_tagged'"),
                "return_indices" to Schemas.bool("If true, every per-stop body includes its triangle_indices"),
                "session_id" to AiPaintTools.SESSION_ID_SCHEMA,
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val plan = when (val r = AiPaintTools.preflight(ws, args)) {
                is AiPaintTools.Either.Left -> return r.value
                is AiPaintTools.Either.Right -> r.value
            }
            val (dx, dy, dz) = parseDirection(args)
                ?: return ToolResult.error("Provide axis='x'|'y'|'z' or direction:{x,y,z} with non-zero magnitude.")
            val arr = args.optJSONArray("stops")
                ?: return ToolResult.error("'stops' array required")
            val (stops, err) = parseStops(arr)
            if (err != null) return ToolResult.error(err)
            val buckets = AiProceduralPaint.gradient(plan.bvh, dx, dy, dz, stops)
            val extra = JSONObject().apply {
                put("direction", JSONObject().apply {
                    put("x", dx.toDouble()); put("y", dy.toDouble()); put("z", dz.toDouble())
                })
            }
            return emitProceduralStops(
                ws, plan, stops, buckets,
                "paint_gradient dir=($dx,$dy,$dz)",
                extra,
                returnIndices = AiPaintTools.returnIndicesFlag(args),
            )
        }

        private fun parseDirection(args: JSONObject): Triple<Float, Float, Float>? {
            args.optJSONObject("direction")?.let { d ->
                val x = d.optFloat("x") ?: return@let
                val y = d.optFloat("y") ?: return@let
                val z = d.optFloat("z") ?: return@let
                if (x * x + y * y + z * z > 0f) return Triple(x, y, z)
            }
            val ax = args.optString("axis", "").lowercase()
            return when (ax) {
                "x" -> Triple(1f, 0f, 0f)
                "y" -> Triple(0f, 1f, 0f)
                "", "z" -> Triple(0f, 0f, 1f)
                else -> null
            }
        }
    }

    // ---- paint_noise ----

    class PaintNoise(private val ws: WorkspaceModel) : Tool {
        override val name = "paint_noise"
        override val description =
            "Procedural noise paint: sample a deterministic 3D value-noise field at each triangle's " +
                "centroid (centered_preview_mm) and assign each triangle to the first stop whose " +
                "[t_lo, t_hi] band contains the sampled value. Use this for camo/weathered/marble " +
                "looks — pass three stops covering the [0,1] range mapped to three filament slots. " +
                "Same (seed, frequency_per_mm) reproduces the exact same paint every time."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "stops", "tag"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "kind" to Schemas.string("'color' (default) | 'support' | 'seam' | 'fuzzy_skin'"),
                "frequency_per_mm" to Schemas.number(
                    "Spatial frequency. 0.05 ≈ one cycle per 20 mm (broad blobs); 0.5 ≈ per 2 mm " +
                        "(fine speckle). Default 0.05.",
                ),
                "seed" to Schemas.integer("Noise seed; same seed + frequency yields the same paint. Default 0."),
                "stops" to JSONObject().apply {
                    put("type", "array")
                    put("description", "Same shape as paint_gradient — list of {t_lo, t_hi, tag}.")
                    put("items", Schemas.obj(
                        required = listOf("t_lo", "t_hi", "tag"),
                        properties = mapOf(
                            "t_lo" to Schemas.number(""),
                            "t_hi" to Schemas.number(""),
                            "tag" to Schemas.integer(""),
                        ),
                    ))
                },
                "tag" to Schemas.integer("Any of your stop tags (used by preflight)"),
                "merge" to Schemas.string("'replace' (default) | 'only_unpainted' | 'only_tagged'"),
                "where_tag" to Schemas.integer("Required when merge='only_tagged'"),
                "return_indices" to Schemas.bool("If true, per-stop bodies include triangle_indices"),
                "session_id" to AiPaintTools.SESSION_ID_SCHEMA,
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val plan = when (val r = AiPaintTools.preflight(ws, args)) {
                is AiPaintTools.Either.Left -> return r.value
                is AiPaintTools.Either.Right -> r.value
            }
            val freq = args.optFloat("frequency_per_mm") ?: 0.05f
            if (freq <= 0f) return ToolResult.error("frequency_per_mm must be > 0; got $freq")
            val seed = args.optInt("seed", 0)
            val arr = args.optJSONArray("stops")
                ?: return ToolResult.error("'stops' array required")
            val (stops, err) = parseStops(arr)
            if (err != null) return ToolResult.error(err)
            val buckets = AiProceduralPaint.valueNoise(plan.bvh, freq, seed, stops)
            val extra = JSONObject().apply {
                put("frequency_per_mm", freq.toDouble())
                put("seed", seed)
            }
            return emitProceduralStops(
                ws, plan, stops, buckets,
                "paint_noise freq=${freq}/mm seed=$seed",
                extra,
                returnIndices = AiPaintTools.returnIndicesFlag(args),
            )
        }
    }

    // ---- paint_frustum ----

    class PaintFrustum(private val ws: WorkspaceModel) : Tool {
        override val name = "paint_frustum"
        override val description =
            "Paint every triangle whose centroid projects inside a 2D pixel bbox in the supplied " +
                "camera AND whose outward normal faces the camera (back-face filter). Cheaper and " +
                "more reliable than paint_projected_mask for rectangular selections — the LLM picks " +
                "out a region by drawing a box on a render_view image instead of authoring a polygon. " +
                "Use connected_only=true to keep only triangles that belong to a connected component " +
                "with at least one in-bbox triangle (filters out small floating matches that aren't " +
                "part of a larger feature)."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "camera_descriptor", "bbox_px", "tag"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "kind" to Schemas.string("'color' (default) | 'support' | 'seam' | 'fuzzy_skin'"),
                "camera_descriptor" to Schemas.obj(
                    properties = mapOf(
                        "view_matrix_4x4" to JSONObject().apply {
                            put("type", "array"); put("items", Schemas.number(""))
                        },
                        "projection_matrix_4x4" to JSONObject().apply {
                            put("type", "array"); put("items", Schemas.number(""))
                        },
                        "width_px" to Schemas.integer(""),
                        "height_px" to Schemas.integer(""),
                    ),
                ),
                "bbox_px" to Schemas.obj(
                    required = listOf("x1", "y1", "x2", "y2"),
                    properties = mapOf(
                        "x1" to Schemas.number("Left edge in pixels (top-left origin)"),
                        "y1" to Schemas.number("Top edge in pixels"),
                        "x2" to Schemas.number("Right edge in pixels"),
                        "y2" to Schemas.number("Bottom edge in pixels"),
                    ),
                ),
                "back_face_filter" to Schemas.bool(
                    "Reject triangles whose normal faces away from the camera (default true)",
                ),
                "connected_only" to Schemas.bool(
                    "If true, expand the matched set to every triangle in the same connected " +
                        "component as ANY in-bbox match. Default false.",
                ),
                "tag" to Schemas.integer("Tag to apply"),
                "merge" to Schemas.string("'replace' (default) | 'only_unpainted' | 'only_tagged'"),
                "where_tag" to Schemas.integer("Required when merge='only_tagged'"),
                "return_indices" to Schemas.bool("If true, response includes triangle_indices"),
                "session_id" to AiPaintTools.SESSION_ID_SCHEMA,
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val plan = when (val r = AiPaintTools.preflight(ws, args)) {
                is AiPaintTools.Either.Left -> return r.value
                is AiPaintTools.Either.Right -> r.value
            }
            val descriptor = args.optJSONObject("camera_descriptor")
                ?: return ToolResult.error("'camera_descriptor' is required")
            val view = descriptor.optJSONArray("view_matrix_4x4")
                ?: return ToolResult.error("camera_descriptor.view_matrix_4x4 missing")
            val proj = descriptor.optJSONArray("projection_matrix_4x4")
                ?: return ToolResult.error("camera_descriptor.projection_matrix_4x4 missing")
            if (view.length() != 16 || proj.length() != 16) {
                return ToolResult.error("view + proj matrices must each be 16 floats")
            }
            val w = descriptor.optInt("width_px", 0)
            val h = descriptor.optInt("height_px", 0)
            if (w <= 0 || h <= 0) return ToolResult.error("camera_descriptor.{width,height}_px > 0 required")
            val bbox = args.optJSONObject("bbox_px")
                ?: return ToolResult.error("'bbox_px' object required")
            val x1 = bbox.optFloat("x1") ?: return ToolResult.error("bbox_px.x1 missing")
            val y1 = bbox.optFloat("y1") ?: return ToolResult.error("bbox_px.y1 missing")
            val x2 = bbox.optFloat("x2") ?: return ToolResult.error("bbox_px.x2 missing")
            val y2 = bbox.optFloat("y2") ?: return ToolResult.error("bbox_px.y2 missing")
            val xLo = minOf(x1, x2); val xHi = maxOf(x1, x2)
            val yLo = minOf(y1, y2); val yHi = maxOf(y1, y2)
            if (xHi - xLo < 1f || yHi - yLo < 1f) {
                return ToolResult.error("bbox_px must be at least 1 pixel wide and tall")
            }
            val backFace = args.optBoolean("back_face_filter", true)
            val connectedOnly = args.optBoolean("connected_only", false)
            val viewArr = FloatArray(16) { view.optDouble(it, 0.0).toFloat() }
            val projArr = FloatArray(16) { proj.optDouble(it, 0.0).toFloat() }
            val cam = AiRenderEngine.CameraSpec(viewArr, projArr, w, h)

            val matched = projectFrustum(plan.bvh, cam, xLo, yLo, xHi, yHi, backFace)
            val candidates = if (connectedOnly && matched.isNotEmpty()) {
                expandToComponents(plan.bvh, matched)
            } else {
                matched
            }
            val extra = JSONObject().apply {
                put("bbox_px", JSONObject().apply {
                    put("x1", xLo.toDouble()); put("y1", yLo.toDouble())
                    put("x2", xHi.toDouble()); put("y2", yHi.toDouble())
                })
                put("back_face_filter", backFace)
                put("connected_only", connectedOnly)
                put("matched_in_bbox", matched.size)
            }
            return AiPaintTools.emitAndRespond(
                ws, plan, candidates,
                "paint_frustum bbox=[${xLo.toInt()},${yLo.toInt()},${xHi.toInt()},${yHi.toInt()}]" +
                    if (connectedOnly) " connected_only" else "",
                extra,
                returnIndices = AiPaintTools.returnIndicesFlag(args),
            )
        }

        private fun projectFrustum(
            bvh: MeshBvh,
            cam: AiRenderEngine.CameraSpec,
            xLo: Float, yLo: Float, xHi: Float, yHi: Float,
            backFaceFilter: Boolean,
        ): IntArray {
            // Build MVP and walk every triangle. For the centered_preview
            // model sizes we expect (~10K..1.4M tris) this is O(triCount)
            // matrix multiplies — fast enough; no BVH descent needed
            // because the bbox in screen space doesn't translate cleanly
            // into a 3D AABB (the camera frustum cuts diagonally through
            // mesh-local space).
            val mvp = matMul(cam.projMatrixRowMajor, cam.viewMatrixRowMajor)
            val invView = invert4x4(cam.viewMatrixRowMajor)
            val camOrigin = if (invView != null) {
                Vec3f(invView[3], invView[7], invView[11])
            } else {
                Vec3f(0f, 0f, 0f)
            }
            val out = ArrayList<Int>(1024)
            val w = cam.widthPx.toFloat()
            val h = cam.heightPx.toFloat()
            for (i in 0 until bvh.triCount) {
                val c = bvh.triangleCentroid(i)
                val cx = mvp[0] * c.x + mvp[1] * c.y + mvp[2] * c.z + mvp[3]
                val cy = mvp[4] * c.x + mvp[5] * c.y + mvp[6] * c.z + mvp[7]
                val cz = mvp[8] * c.x + mvp[9] * c.y + mvp[10] * c.z + mvp[11]
                val cw = mvp[12] * c.x + mvp[13] * c.y + mvp[14] * c.z + mvp[15]
                if (cw <= 0f) continue   // behind the camera
                val ndcX = cx / cw
                val ndcY = cy / cw
                val ndcZ = cz / cw
                if (ndcZ < -1f || ndcZ > 1f) continue   // outside near/far
                val px = (ndcX * 0.5f + 0.5f) * w
                val py = (1f - (ndcY * 0.5f + 0.5f)) * h
                if (px < xLo || px > xHi || py < yLo || py > yHi) continue
                if (backFaceFilter && invView != null) {
                    val n = bvh.triangleNormal(i)
                    val dx = c.x - camOrigin.x
                    val dy = c.y - camOrigin.y
                    val dz = c.z - camOrigin.z
                    if (n.x * dx + n.y * dy + n.z * dz >= 0f) continue
                }
                out.add(i)
            }
            return out.toIntArray()
        }

        private fun expandToComponents(bvh: MeshBvh, seeds: IntArray): IntArray {
            val seen = HashSet<Int>(seeds.size * 4)
            for (s in seeds) {
                if (s in seen) continue
                val component = bvh.connectedComponent(s, maxTriangles = 1_500_000)
                for (t in component) seen.add(t)
            }
            val arr = seen.toIntArray()
            java.util.Arrays.sort(arr)
            return arr
        }

        private fun matMul(a: FloatArray, b: FloatArray): FloatArray {
            val out = FloatArray(16)
            for (i in 0 until 4) for (j in 0 until 4) {
                var s = 0f
                for (k in 0 until 4) s += a[i * 4 + k] * b[k * 4 + j]
                out[i * 4 + j] = s
            }
            return out
        }

        private fun invert4x4(m: FloatArray): FloatArray? {
            val a = m
            val inv = FloatArray(16)
            inv[0] =  a[5]*a[10]*a[15] - a[5]*a[11]*a[14] - a[9]*a[6]*a[15] + a[9]*a[7]*a[14] + a[13]*a[6]*a[11] - a[13]*a[7]*a[10]
            inv[4] = -a[4]*a[10]*a[15] + a[4]*a[11]*a[14] + a[8]*a[6]*a[15] - a[8]*a[7]*a[14] - a[12]*a[6]*a[11] + a[12]*a[7]*a[10]
            inv[8] =  a[4]*a[9]*a[15]  - a[4]*a[11]*a[13] - a[8]*a[5]*a[15] + a[8]*a[7]*a[13] + a[12]*a[5]*a[11] - a[12]*a[7]*a[9]
            inv[12] = -a[4]*a[9]*a[14]  + a[4]*a[10]*a[13] + a[8]*a[5]*a[14] - a[8]*a[6]*a[13] - a[12]*a[5]*a[10] + a[12]*a[6]*a[9]
            inv[1] = -a[1]*a[10]*a[15] + a[1]*a[11]*a[14] + a[9]*a[2]*a[15] - a[9]*a[3]*a[14] - a[13]*a[2]*a[11] + a[13]*a[3]*a[10]
            inv[5] =  a[0]*a[10]*a[15] - a[0]*a[11]*a[14] - a[8]*a[2]*a[15] + a[8]*a[3]*a[14] + a[12]*a[2]*a[11] - a[12]*a[3]*a[10]
            inv[9] = -a[0]*a[9]*a[15]  + a[0]*a[11]*a[13] + a[8]*a[1]*a[15] - a[8]*a[3]*a[13] - a[12]*a[1]*a[11] + a[12]*a[3]*a[9]
            inv[13] =  a[0]*a[9]*a[14]  - a[0]*a[10]*a[13] - a[8]*a[1]*a[14] + a[8]*a[2]*a[13] + a[12]*a[1]*a[10] - a[12]*a[2]*a[9]
            inv[2] =  a[1]*a[6]*a[15]  - a[1]*a[7]*a[14]  - a[5]*a[2]*a[15] + a[5]*a[3]*a[14] + a[13]*a[2]*a[7]  - a[13]*a[3]*a[6]
            inv[6] = -a[0]*a[6]*a[15]  + a[0]*a[7]*a[14]  + a[4]*a[2]*a[15] - a[4]*a[3]*a[14] - a[12]*a[2]*a[7]  + a[12]*a[3]*a[6]
            inv[10] =  a[0]*a[5]*a[15]  - a[0]*a[7]*a[13]  - a[4]*a[1]*a[15] + a[4]*a[3]*a[13] + a[12]*a[1]*a[7]  - a[12]*a[3]*a[5]
            inv[14] = -a[0]*a[5]*a[14]  + a[0]*a[6]*a[13]  + a[4]*a[1]*a[14] - a[4]*a[2]*a[13] - a[12]*a[1]*a[6]  + a[12]*a[2]*a[5]
            inv[3] = -a[1]*a[6]*a[11]  + a[1]*a[7]*a[10]  + a[5]*a[2]*a[11] - a[5]*a[3]*a[10] - a[9]*a[2]*a[7]   + a[9]*a[3]*a[6]
            inv[7] =  a[0]*a[6]*a[11]  - a[0]*a[7]*a[10]  - a[4]*a[2]*a[11] + a[4]*a[3]*a[10] + a[8]*a[2]*a[7]   - a[8]*a[3]*a[6]
            inv[11] = -a[0]*a[5]*a[11]  + a[0]*a[7]*a[9]   + a[4]*a[1]*a[11] - a[4]*a[3]*a[9]  - a[8]*a[1]*a[7]   + a[8]*a[3]*a[5]
            inv[15] =  a[0]*a[5]*a[10]  - a[0]*a[6]*a[9]   - a[4]*a[1]*a[10] + a[4]*a[2]*a[9]  + a[8]*a[1]*a[6]   - a[8]*a[2]*a[5]
            val det = a[0]*inv[0] + a[1]*inv[4] + a[2]*inv[8] + a[3]*inv[12]
            if (kotlin.math.abs(det) < 1e-10) return null
            val invDet = 1f / det
            for (i in 0 until 16) inv[i] *= invDet
            return inv
        }
    }
}
