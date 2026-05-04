package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiPaintEngine
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Polyline brush stroke. The LLM passes a list of 3D points and a
 * radius; we densify the polyline at sub-radius spacing, find the
 * nearest triangle to each sample, then take the union of geodesic
 * discs around each sample and paint that union as one
 * [paint_triangle_list] dispatch.
 *
 * This is the primitive a human painter actually thinks in — "drag
 * the brush from here to here" — and it's what shape grammars like
 * "stroke along the spine of the dragon" decompose to. It makes far
 * better use of LLM tokens than enumerating triangle ids per stamp,
 * AND respects the same dihedral-hard-edge gating that
 * paint_geodesic_disc does, so a stroke across the bridge of a nose
 * doesn't bleed onto the cheeks.
 *
 * Implementation notes:
 *  - Densification: sample step = radius / 2 (Nyquist on a flat
 *    surface). Heavily-curved surfaces will see more overlap; flat
 *    surfaces see exact-cover with mild overlap.
 *  - Seed-tri lookup per sample: nearest centroid inside an axis-
 *    aligned bounding box of size 2 × radius around the sample
 *    point. Falls back to the BVH's triangle-by-tri-id linear scan
 *    for samples that miss the bbox prefilter (rare — only when the
 *    sample is outside the mesh AABB).
 *  - Union semantics: a triangle painted by any sample's disc is
 *    painted, period. Subsequent strokes can re-paint with merge=
 *    only_unpainted to do under-painting.
 */
internal class PaintStrokeTool(
    private val ws: WorkspaceModel,
    private val paintTools: List<Tool>,
) : Tool {
    override val name = "paint_stroke"
    override val description =
        "Paint along a polyline with a soft round brush. The LLM passes a list of 3D points " +
            "(centered_preview_mm) and a radius; the tool densifies the polyline at radius/2 " +
            "spacing, finds the nearest mesh triangle to each sample, and takes the union of " +
            "geodesic discs (so the paint stays on the SURFACE and respects dihedral hard " +
            "edges — won't bleed across a cheek crease). Dispatches as a single " +
            "paint_triangle_list call so it's one undo step. respect_hard_edges=true (default) " +
            "uses dihedral_limit_deg as the per-step crease cutoff; set respect_hard_edges=false " +
            "or dihedral_limit_deg=180 to ignore curvature and use radius alone."
    override val inputSchema = Schemas.obj(
        required = listOf("model_id", "points", "radius_mm", "tag"),
        properties = mapOf(
            "model_id" to Schemas.string("Model id"),
            "kind" to Schemas.string("'color' (default) | 'support' | 'seam' | 'fuzzy_skin'"),
            "points" to JSONObject().apply {
                put("type", "array")
                put("description",
                    "Polyline samples in centered_preview_mm. Each entry is {x, y, z}. " +
                        "Minimum 1 (degenerates to paint_geodesic_disc); typical strokes are " +
                        "2..32 control points.")
                put("items", Schemas.obj(
                    required = listOf("x", "y", "z"),
                    properties = mapOf(
                        "x" to Schemas.number("X in centered_preview_mm"),
                        "y" to Schemas.number("Y in centered_preview_mm"),
                        "z" to Schemas.number("Z in centered_preview_mm"),
                    ),
                ))
            },
            "radius_mm" to Schemas.number("Brush radius in mm (geodesic, NOT euclidean)"),
            "respect_hard_edges" to Schemas.bool(
                "If true (default) the disc walk stops at dihedral creases above " +
                    "dihedral_limit_deg. Set false to ignore curvature.",
            ),
            "dihedral_limit_deg" to Schemas.number(
                "Per-step dihedral cutoff (default 60°). Smaller = stays on flatter regions; " +
                    "180° = walks everywhere within radius.",
            ),
            "max_triangles" to Schemas.integer(
                "Hard cap on the union size (default 65536). Caps total stroke triangle count.",
            ),
            "tag" to Schemas.integer("Tag to apply"),
            "merge" to Schemas.string("'replace' (default) | 'only_unpainted' | 'only_tagged'"),
            "where_tag" to Schemas.integer("Required when merge='only_tagged'"),
            "session_id" to AiPaintTools.SESSION_ID_SCHEMA,
        ),
    )
    override suspend fun call(args: JSONObject): ToolResult {
        if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
        val modelId = args.optString("model_id").trim()
        if (modelId.isEmpty()) return ToolResult.error("'model_id' is required.")
        val bvh = ws.getBvh(modelId)
            ?: return ToolResult.error("Couldn't build BVH for '$modelId'.")
        val pointsRaw = args.optJSONArray("points")
            ?: return ToolResult.error("'points' array is required.")
        if (pointsRaw.length() == 0) return ToolResult.error("points must contain at least one entry.")
        if (pointsRaw.length() > 256) {
            return ToolResult.error("points capped at 256 entries; got ${pointsRaw.length()}.")
        }
        val ctrl = ArrayList<FloatArray>(pointsRaw.length())
        for (i in 0 until pointsRaw.length()) {
            val p = pointsRaw.optJSONObject(i)
                ?: return ToolResult.error("points[$i] must be an object {x,y,z}.")
            val x = optFloat(p, "x") ?: return ToolResult.error("points[$i].x missing.")
            val y = optFloat(p, "y") ?: return ToolResult.error("points[$i].y missing.")
            val z = optFloat(p, "z") ?: return ToolResult.error("points[$i].z missing.")
            ctrl.add(floatArrayOf(x, y, z))
        }
        val radius = optFloat(args, "radius_mm")
            ?: return ToolResult.error("'radius_mm' is required.")
        if (radius <= 0f) return ToolResult.error("radius_mm must be > 0.")
        val respectEdges = args.optBoolean("respect_hard_edges", true)
        val dihedralRaw = optFloat(args, "dihedral_limit_deg") ?: 60f
        val dihedralLimit = if (respectEdges) dihedralRaw.coerceIn(0f, 180f) else 180f
        val maxTri = args.optInt("max_triangles", 65_536).coerceIn(1, 1_500_000)

        // 1) Densify the polyline at radius/2 spacing (the brush is a
        //    geodesic disc, so flat-surface coverage works at radius
        //    spacing; we use radius/2 to compensate for curvature
        //    cutoff at hard edges).
        val step = radius * 0.5f
        val samples = ArrayList<FloatArray>()
        samples.add(ctrl[0])
        for (i in 1 until ctrl.size) {
            val a = ctrl[i - 1]
            val b = ctrl[i]
            val dx = b[0] - a[0]; val dy = b[1] - a[1]; val dz = b[2] - a[2]
            val seg = sqrt(dx * dx + dy * dy + dz * dz)
            val n = max(1, (seg / step).toInt())
            for (k in 1..n) {
                val t = k.toFloat() / n
                samples.add(floatArrayOf(
                    a[0] + dx * t, a[1] + dy * t, a[2] + dz * t,
                ))
            }
        }
        // 2) Resolve each sample to a seed triangle (nearest centroid)
        //    and run geodesicDisc per sample. Union into a HashSet so
        //    the same triangle painted by overlapping discs only emits
        //    once.
        val union = HashSet<Int>(samples.size * 8)
        var resolvedSeeds = 0
        var missedSamples = 0
        for (sample in samples) {
            val seed = nearestSeed(bvh, sample[0], sample[1], sample[2], radius)
            if (seed < 0) { missedSamples++; continue }
            resolvedSeeds++
            val disc = AiPaintEngine.geodesicDisc(
                bvh = bvh,
                seedTri = seed,
                radiusMm = radius,
                maxDihedralDeg = dihedralLimit,
                maxTriangles = maxTri,
            )
            for (t in disc) {
                union.add(t)
                if (union.size >= maxTri) break
            }
            if (union.size >= maxTri) break
        }
        if (union.isEmpty()) {
            return ToolResult.error(
                "paint_stroke produced an empty triangle set " +
                    "(samples=${samples.size}, missed=$missedSamples). The polyline " +
                    "may be too far from the mesh surface — check the points are in " +
                    "centered_preview_mm and within ~radius of the mesh.",
            )
        }
        val sortedIds = union.toIntArray().also { it.sort() }
        // 3) Dispatch through paint_triangle_list so all the merge /
        //    tag / session machinery runs once with the unioned set.
        val triList = paintTools.firstOrNull { it.name == "paint_triangle_list" }
            ?: return ToolResult.error("paint_triangle_list not registered.")
        val forwarded = JSONObject().apply {
            put("model_id", modelId)
            if (args.has("kind")) put("kind", args.opt("kind"))
            if (args.has("tag")) put("tag", args.opt("tag"))
            if (args.has("merge")) put("merge", args.opt("merge"))
            if (args.has("where_tag")) put("where_tag", args.opt("where_tag"))
            if (args.has("session_id")) put("session_id", args.optString("session_id"))
            val ids = JSONArray().apply { for (t in sortedIds) put(t) }
            put("triangle_ids", ids)
        }
        val r = triList.call(forwarded)
        val structured = r.structured ?: JSONObject()
        structured.put("control_point_count", ctrl.size)
        structured.put("sample_count", samples.size)
        structured.put("resolved_seed_count", resolvedSeeds)
        structured.put("missed_sample_count", missedSamples)
        structured.put("union_triangle_count", union.size)
        structured.put("radius_mm", radius.toDouble())
        structured.put("dihedral_limit_deg", dihedralLimit.toDouble())
        structured.put("respect_hard_edges", respectEdges)
        val text = if (r.isError) {
            "paint_stroke (${ctrl.size} ctrl, ${samples.size} samples): ${r.text}"
        } else {
            "paint_stroke (${ctrl.size} ctrl pts → ${samples.size} samples → ${union.size} tris): ${r.text}"
        }
        return ToolResult(text, structured, isError = r.isError)
    }

    /**
     * Find the BVH triangle whose centroid is nearest to [px,py,pz]
     * within an AABB of half-extent [search]. Returns -1 if no
     * triangle's centroid lies in the AABB. Linear in the AABB-
     * filtered candidate set (typically tiny vs full triCount).
     */
    private fun nearestSeed(
        bvh: MeshBvh,
        px: Float, py: Float, pz: Float,
        search: Float,
    ): Int {
        // Try a tight box first; expand to 4× radius if empty (e.g.
        // the user clicked a point a bit outside the mesh surface).
        var s = search
        repeat(3) {
            val candidates = bvh.aabbOverlapTriangles(
                px - s, py - s, pz - s,
                px + s, py + s, pz + s,
            )
            if (candidates.isNotEmpty()) {
                var best = -1
                var bestDist = Float.POSITIVE_INFINITY
                for (t in candidates) {
                    val c = bvh.triangleCentroid(t)
                    val dx = c.x - px; val dy = c.y - py; val dz = c.z - pz
                    val d2 = dx * dx + dy * dy + dz * dz
                    if (d2 < bestDist) {
                        bestDist = d2
                        best = t
                    }
                }
                if (best >= 0) return best
            }
            s *= 2f  // expand search if the tight box was empty
        }
        return -1
    }

    private fun optFloat(o: JSONObject, key: String): Float? {
        if (!o.has(key)) return null
        return when (val v = o.opt(key)) {
            is Number -> v.toFloat()
            is String -> v.toFloatOrNull()
            else -> null
        }
    }
}
