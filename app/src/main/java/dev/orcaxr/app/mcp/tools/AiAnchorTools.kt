package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiIntrospection
import dev.orcaxr.app.MAX_PAINT_SLOTS
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.sqrt

/**
 * Anchor tools — turn spatial-reasoning questions into name-picking.
 *
 * Small on-device LLMs (Gemini Nano, Gemma 3n, …) struggle to map a
 * 256² render of a 3D model to printer-frame millimetres. Without
 * help they emit obviously-wrong coordinates ("paint at z=15"
 * regardless of model height) or hallucinate triangle ids. These
 * tools sidestep that by precomputing named landmarks the agent can
 * refer to by string:
 *
 *  - [ListAnchors] returns 6 cardinal face centers + the model
 *    centroid + the largest semantic-region centroid, each with its
 *    centered_preview-frame (x, y, z) and a one-line description.
 *  - [SeedForAnchor] returns the triangle id whose centroid is closest
 *    to a named anchor — directly feedable as `seed_triangle_id` to
 *    paint_connected_component / paint_geodesic_disc / etc. Without
 *    this, paint_connected_component is unusable from a small model
 *    because picking a triangle id from a render is a hard vision
 *    task.
 *  - [PaintCoverageSummary] returns per-tag triangle area + percentage
 *    so the agent can verify a paint operation by reading numbers
 *    instead of looking at a picture (which it's bad at).
 *
 * Anchor coordinate frame matches [AiIntrospection.geometry] —
 * mesh-local mm (which the loader centers, so "centered_preview" is
 * just the mesh-local frame after centering). seed_for_anchor returns
 * a triangle index that's invariant across frames.
 */
internal object AiAnchorTools {

    fun all(ws: WorkspaceModel): List<Tool> = listOf(
        ListAnchors(ws),
        SeedForAnchor(ws),
        PaintCoverageSummary(ws),
    )

    // ---- Shared resolver ----

    private sealed interface ResolvedModel {
        data class Found(val model: PlacedModel, val bvh: MeshBvh) : ResolvedModel
        data object MissingId : ResolvedModel
        data class UnknownId(val id: String, val knownIds: List<String>) : ResolvedModel
        data class BvhNotReady(val id: String) : ResolvedModel
    }

    private suspend fun resolveModelAndBvh(ws: WorkspaceModel, args: JSONObject): ResolvedModel {
        val id = args.optString("model_id").trim()
        if (id.isEmpty()) return ResolvedModel.MissingId
        val placed = ws.placedModels.value
        val model = placed.firstOrNull { it.id == id }
            ?: return ResolvedModel.UnknownId(id, placed.map { it.id })
        val bvh = ws.getBvh(id) ?: return ResolvedModel.BvhNotReady(id)
        return ResolvedModel.Found(model, bvh)
    }

    private fun ResolvedModel.toError(): ToolResult = when (this) {
        is ResolvedModel.Found ->
            ToolResult.error("Internal error: tried to format a Found result.")
        is ResolvedModel.MissingId ->
            ToolResult.error(
                "model_id argument is required. Call list_placed_models first " +
                    "and pass the `id=...` value of the target model.",
            )
        is ResolvedModel.UnknownId ->
            ToolResult.error(
                "No model with id=\"$id\" on the active plate. " +
                    if (knownIds.isEmpty()) "Workspace is empty — load a model first."
                    else "Known ids: ${knownIds.joinToString(", ")}.",
            )
        is ResolvedModel.BvhNotReady ->
            ToolResult.error(
                "Model $id is loading but its BVH isn't built yet. " +
                    "Call get_workspace_state once or twice and retry.",
            )
    }

    // ---- Anchor computation ----

    /**
     * One named anchor on a model. Position is in the same frame
     * AiIntrospection.geometry uses (mesh-local mm). Tagged with a
     * short rationale so the agent can pick the right one without a
     * second tool call to inspect each.
     */
    private data class Anchor(
        val name: String,
        val x: Float, val y: Float, val z: Float,
        val description: String,
    )

    private fun computeAnchors(bvh: MeshBvh): List<Anchor> {
        // bins=1 here — we only need bbox + centroid; the histogram is
        // dead weight at this call site but the function is shared with
        // every other render path, so reuse rather than duplicate the
        // bbox loop.
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val bb = geom.bboxCenteredPreview
        val cx = bb.centerX; val cy = bb.centerY; val cz = bb.centerZ
        val cxC = geom.centroidCenteredPreview[0]
        val cyC = geom.centroidCenteredPreview[1]
        val czC = geom.centroidCenteredPreview[2]

        val anchors = ArrayList<Anchor>(8)
        anchors += Anchor(
            "top_center", cx, cy, bb.maxZ,
            "Center of the top face (highest Z). Good for crowns, hats, lids.",
        )
        anchors += Anchor(
            "bottom_center", cx, cy, bb.minZ,
            "Center of the bottom face (lowest Z). Good for magnet pockets, base inserts.",
        )
        anchors += Anchor(
            "front_center", cx, bb.minY, cz,
            "Center of the -Y face (camera-facing side from `front` preset).",
        )
        anchors += Anchor(
            "back_center", cx, bb.maxY, cz,
            "Center of the +Y face (opposite the `front` preset).",
        )
        anchors += Anchor(
            "left_center", bb.minX, cy, cz,
            "Center of the -X face (visible from the `left` preset).",
        )
        anchors += Anchor(
            "right_center", bb.maxX, cy, cz,
            "Center of the +X face (visible from the `right` preset).",
        )
        anchors += Anchor(
            "center", cxC, cyC, czC,
            "Surface-area-weighted centroid of the whole mesh.",
        )
        // Largest-region centroid only meaningful when semanticRegions
        // returns at least one cluster (empty meshes / pathological
        // single-tri scenes return nothing). For typical models the
        // first region is the dominant flat face / curved hull.
        val regions = AiIntrospection.semanticRegions(bvh, maxRegions = 1)
        regions.firstOrNull()?.let { r ->
            anchors += Anchor(
                "largest_region_center",
                r.centroid[0], r.centroid[1], r.centroid[2],
                "Centroid of the dominant semantic region (label='${r.label}', " +
                    "${"%.1f".format(r.areaMm2)} mm²). Best seed for " +
                    "paint_connected_component to colour the model's main body.",
            )
        }
        return anchors
    }

    // ---- list_anchors ----

    class ListAnchors(private val ws: WorkspaceModel) : Tool {
        override val name = "list_anchors"
        override val description =
            "Return named landmarks on the model — bbox face centers (top/bottom/front/" +
                "back/left/right_center), the surface-weighted centroid (center), and the " +
                "centroid of the largest semantic region (largest_region_center). Each entry " +
                "has a (x, y, z) position in mesh-local mm and a one-line description. Use " +
                "this BEFORE picking coordinates for paint_sphere / add_volume_to_model — " +
                "it lets you say 'paint near top_center' without computing geometry yourself. " +
                "Pair with seed_for_anchor to get a triangle id for paint_connected_component."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf("model_id" to Schemas.string("Model id from list_placed_models")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val resolved = resolveModelAndBvh(ws, args)
            if (resolved !is ResolvedModel.Found) return resolved.toError()
            val (_, bvh) = resolved.model to resolved.bvh
            val anchors = computeAnchors(bvh)
            val arr = JSONArray()
            for (a in anchors) {
                arr.put(JSONObject().apply {
                    put("name", a.name)
                    put("x", a.x.toDouble())
                    put("y", a.y.toDouble())
                    put("z", a.z.toDouble())
                    put("description", a.description)
                })
            }
            val text = buildString {
                append("Anchors for ${resolved.model.id} (${anchors.size}):\n")
                for (a in anchors) {
                    append("  ${a.name}  (")
                    append("%.1f".format(a.x)); append(", ")
                    append("%.1f".format(a.y)); append(", ")
                    append("%.1f".format(a.z)); append(") mm — ")
                    append(a.description); append('\n')
                }
            }.trimEnd()
            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", resolved.model.id)
                put("anchors", arr)
            }
            return ToolResult.ok(text, body)
        }
    }

    // ---- seed_for_anchor ----

    class SeedForAnchor(private val ws: WorkspaceModel) : Tool {
        override val name = "seed_for_anchor"
        override val description =
            "Return the triangle index whose centroid is closest to a named anchor (see " +
                "list_anchors). Use this to get a `seed_triangle_id` argument for " +
                "paint_connected_component, paint_surface_region, and paint_geodesic_disc " +
                "without picking pixels off a render. Custom point: pass `position` instead " +
                "of `anchor` (a {x,y,z} object in mesh-local mm) to find the closest triangle " +
                "to an arbitrary location."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "anchor" to Schemas.string(
                    "Anchor name from list_anchors (top_center, bottom_center, front_center, " +
                        "back_center, left_center, right_center, center, largest_region_center). " +
                        "Required if `position` is omitted.",
                ),
                "position" to Schemas.obj(
                    properties = mapOf(
                        "x" to Schemas.number("x in mesh-local mm"),
                        "y" to Schemas.number("y in mesh-local mm"),
                        "z" to Schemas.number("z in mesh-local mm"),
                    ),
                ),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val resolved = resolveModelAndBvh(ws, args)
            if (resolved !is ResolvedModel.Found) return resolved.toError()
            val (model, bvh) = resolved.model to resolved.bvh
            // Resolve target point: explicit position wins, else anchor name.
            val (tx, ty, tz, label) = run {
                val posObj = args.optJSONObject("position")
                if (posObj != null) {
                    val x = posObj.optDouble("x", Double.NaN).toFloat()
                    val y = posObj.optDouble("y", Double.NaN).toFloat()
                    val z = posObj.optDouble("z", Double.NaN).toFloat()
                    if (x.isNaN() || y.isNaN() || z.isNaN()) {
                        return ToolResult.error(
                            "`position` must include numeric x, y, z. Got: $posObj",
                        )
                    }
                    Quad(x, y, z, "position(${"%.1f".format(x)}, ${"%.1f".format(y)}, ${"%.1f".format(z)})")
                } else {
                    val anchor = args.optString("anchor").trim()
                    if (anchor.isEmpty()) {
                        return ToolResult.error(
                            "Either `anchor` (e.g. \"top_center\") or `position` is required. " +
                                "Call list_anchors to see available names.",
                        )
                    }
                    val anchors = computeAnchors(bvh)
                    val a = anchors.firstOrNull { it.name == anchor }
                        ?: return ToolResult.error(
                            "Unknown anchor '$anchor'. Available: ${anchors.joinToString(", ") { it.name }}.",
                        )
                    Quad(a.x, a.y, a.z, anchor)
                }
            }
            // O(n) scan over triangle centroids. Pixel-fast on Tensor G5
            // for typical Benchy-class meshes (40K tris). If this ever
            // matters we can BVH-accelerate via aabbOverlapTriangles
            // around an expanding box, but the constant-factor here is
            // small enough that the indirection isn't worth it yet.
            val n = bvh.triCount
            if (n == 0) return ToolResult.error("Mesh is empty (0 triangles).")
            var bestTri = -1
            var bestDistSq = Float.POSITIVE_INFINITY
            for (i in 0 until n) {
                val c = bvh.triangleCentroid(i)
                val dx = c.x - tx; val dy = c.y - ty; val dz = c.z - tz
                val d2 = dx * dx + dy * dy + dz * dz
                if (d2 < bestDistSq) {
                    bestDistSq = d2
                    bestTri = i
                }
            }
            if (bestTri < 0) return ToolResult.error("Couldn't find a closest triangle (mesh may be degenerate).")
            val c = bvh.triangleCentroid(bestTri)
            val dist = sqrt(bestDistSq.toDouble()).toFloat()
            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", model.id)
                put("seed_triangle_id", bestTri)
                put("anchor_or_position", label)
                put("centroid", JSONObject().apply {
                    put("x", c.x.toDouble()); put("y", c.y.toDouble()); put("z", c.z.toDouble())
                })
                put("distance_mm", dist.toDouble())
            }
            val text = "seed_triangle_id=$bestTri (centroid ${"%.1f".format(c.x)}, " +
                "${"%.1f".format(c.y)}, ${"%.1f".format(c.z)} mm; ${"%.1f".format(dist)} mm from $label)"
            return ToolResult.ok(text, body)
        }

        private data class Quad(val x: Float, val y: Float, val z: Float, val label: String)
    }

    // ---- paint_coverage_summary ----

    class PaintCoverageSummary(private val ws: WorkspaceModel) : Tool {
        override val name = "paint_coverage_summary"
        override val description =
            "Return per-tag paint coverage as triangle area (mm²) and percentage of total " +
                "surface area, for one or more paint kinds. Use this to verify a paint " +
                "operation by reading numbers instead of comparing renders. Default kinds: " +
                "[\"color\"]. Pass kinds=[\"color\",\"support\",\"seam\",\"fuzzy\"] to get a " +
                "full breakdown. Tag 0 is always the unpainted residue; for color, tags 1..N " +
                "match list_active_palette slots (slot_index = tag − 1)."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "kinds" to Schemas.stringArray(
                    "Subset of [\"color\", \"support\", \"seam\", \"fuzzy\"]. Default [\"color\"].",
                ),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val resolved = resolveModelAndBvh(ws, args)
            if (resolved !is ResolvedModel.Found) return resolved.toError()
            val (model, bvh) = resolved.model to resolved.bvh
            val n = bvh.triCount
            if (n == 0) return ToolResult.error("Mesh is empty (0 triangles).")

            val kindsArg = args.optJSONArray("kinds")
            val requestedKinds: List<String> = if (kindsArg == null || kindsArg.length() == 0) {
                listOf("color")
            } else {
                (0 until kindsArg.length()).map { kindsArg.optString(it).trim().lowercase() }
                    .filter { it.isNotEmpty() }
            }

            // Precompute per-triangle area once — reused across all
            // requested kinds. O(n); cheaper than re-iterating per kind.
            val areas = FloatArray(n)
            var totalArea = 0.0
            for (i in 0 until n) {
                val v0 = bvh.triangleVertex(i, 0)
                val v1 = bvh.triangleVertex(i, 1)
                val v2 = bvh.triangleVertex(i, 2)
                val e1x = v1.x - v0.x; val e1y = v1.y - v0.y; val e1z = v1.z - v0.z
                val e2x = v2.x - v0.x; val e2y = v2.y - v0.y; val e2z = v2.z - v0.z
                val cnx = e1y * e2z - e1z * e2y
                val cny = e1z * e2x - e1x * e2z
                val cnz = e1x * e2y - e1y * e2x
                val len = sqrt(cnx.toDouble() * cnx + cny.toDouble() * cny + cnz.toDouble() * cnz)
                val a = (0.5 * len).toFloat()
                areas[i] = a
                totalArea += a
            }
            val total = totalArea.toFloat().coerceAtLeast(1e-6f)

            val palette = ws.previewPalette.value
            val perKindOut = JSONObject()
            val unknownKinds = ArrayList<String>()
            val textBuilder = StringBuilder()
            textBuilder.append("Coverage for ${model.id} (total ${"%.1f".format(total)} mm²):\n")

            for (kind in requestedKinds) {
                val (arr, maxTag, kindLabel) = when (kind) {
                    "color", "filament" -> Triple(model.paintFilamentIndex, MAX_PAINT_SLOTS, "color")
                    "support" -> Triple(model.supportFlags, 2, "support")
                    "seam" -> Triple(model.seamFlags, 2, "seam")
                    "fuzzy", "fuzzy_skin", "fuzzyskin" -> Triple(model.fuzzySkinFlags, 1, "fuzzy")
                    else -> {
                        unknownKinds += kind
                        continue
                    }
                }
                if (arr == null) {
                    perKindOut.put(kindLabel, JSONObject().apply {
                        put("ever_painted", false)
                        put("entries", JSONArray())
                        put("unpainted_pct", 100.0)
                        put("unpainted_mm2", total.toDouble())
                    })
                    textBuilder.append("  $kindLabel: never painted (100% unpainted)\n")
                    continue
                }
                // Per-tag area accumulator (size = maxTag + 1; tag 0 = unpainted).
                val tagAreas = FloatArray(maxTag + 1)
                for (i in 0 until n) {
                    val tag = arr.getOrNull(i)?.toInt()?.and(0xff) ?: 0
                    if (tag in tagAreas.indices) tagAreas[tag] += areas[i]
                }
                val entries = JSONArray()
                textBuilder.append("  $kindLabel:\n")
                for (tag in tagAreas.indices) {
                    val a = tagAreas[tag]
                    if (a <= 0f && tag != 0) continue
                    val pct = 100.0 * a / total
                    val obj = JSONObject().apply {
                        put("tag", tag)
                        put("area_mm2", a.toDouble())
                        put("pct", pct)
                        if (kindLabel == "color" && tag in 1..palette.size) {
                            put("hex", palette[tag - 1])
                        }
                        if (kindLabel == "color" && tag == 0) put("note", "unpainted")
                        if (kindLabel != "color") {
                            val flagName = when (tag) {
                                0 -> "unpainted"
                                1 -> if (kindLabel == "fuzzy") "fuzzy" else "enforcer"
                                2 -> "blocker"
                                else -> "tag_$tag"
                            }
                            put("flag", flagName)
                        }
                    }
                    entries.put(obj)
                    val display = when {
                        kindLabel == "color" && tag == 0 -> "tag 0 (unpainted)"
                        kindLabel == "color" -> {
                            val hex = palette.getOrNull(tag - 1) ?: "?"
                            "tag $tag ($hex)"
                        }
                        else -> "tag $tag (${
                            when (tag) {
                                0 -> "unpainted"
                                1 -> if (kindLabel == "fuzzy") "fuzzy" else "enforcer"
                                2 -> "blocker"
                                else -> "—"
                            }
                        })"
                    }
                    textBuilder.append("    $display: ${"%.1f".format(a)} mm² (${"%.1f".format(pct)}%)\n")
                }
                perKindOut.put(kindLabel, JSONObject().apply {
                    put("ever_painted", true)
                    put("entries", entries)
                })
            }

            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", model.id)
                put("total_area_mm2", total.toDouble())
                put("triangle_count", n)
                put("kinds", perKindOut)
                if (unknownKinds.isNotEmpty()) {
                    put("unknown_kinds", JSONArray().apply { for (k in unknownKinds) put(k) })
                }
            }
            return ToolResult.ok(textBuilder.toString().trimEnd(), body)
        }
    }
}
