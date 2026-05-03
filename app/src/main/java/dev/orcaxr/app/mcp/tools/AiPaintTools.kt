package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiPaintEngine
import dev.orcaxr.app.MAX_PAINT_SLOTS
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject

/**
 * AI-driven paint pillar (C9 milestone 1) — six MCP tools that compute
 * a triangle index set in **centered_preview_mm** and emit a single
 * `WorkspaceAction.PaintTriangleSet` so the existing
 * `applyPaintMutation` path handles PaintHistory + paint cache +
 * paintContentVersion.
 *
 * Tools:
 * - `paint_sphere` — paint by 3D ball (centroid distance test, optional
 *   back-face filter).
 * - `paint_slab` — paint by axis-aligned span (centroid / any-vertex /
 *   all-vertex tests).
 * - `paint_normal_cone` — paint faces whose outward normal matches a
 *   direction within a half-angle.
 * - `paint_surface_region` — smart-fill from a seed (delegates to
 *   `MeshBvh.smartFillBfs`).
 * - `paint_connected_component` — vertex-adjacency BFS from a seed
 *   (no angle gate).
 * - `paint_triangle_list` — raw escape hatch.
 *
 * Every tool's `structuredContent` includes:
 *   - `painted_count`: matched triangles AFTER the merge filter
 *   - `triangle_count`: matched triangles BEFORE the merge filter
 *   - `triangle_indices`: capped at [MAX_INDICES_RETURNED]
 *   - `truncated_indices`: true iff the cap was hit
 */
internal object AiPaintTools {

    /**
     * Cap on indices returned to the LLM in a single tool result.
     * Matches the design doc § A.4 — keeps the JSON-RPC response under
     * the 1 MB body cap (`HttpFraming.MAX_BODY_BYTES`) for even the
     * widest projected-mask. The full triangle set is still applied
     * server-side; only the response payload is truncated.
     */
    const val MAX_INDICES_RETURNED = 4096

    fun all(ws: WorkspaceModel): List<Tool> {
        val inner = listOf(
            PaintSphere(ws),
            PaintSlab(ws),
            PaintNormalCone(ws),
            PaintSurfaceRegion(ws),
            PaintConnectedComponent(ws),
            PaintTriangleList(ws),
            PaintProjectedMask(ws),
            PaintGeodesicDisc(ws),
        )
        return inner + PaintWithMirror(ws, inner)
    }

    // ---- Shared helpers ----

    /** Same parser the existing paint tools use (color/support/seam/fuzzy). */
    private fun parsePaintKind(raw: String): WorkspaceAction.PaintKind? = when (raw.lowercase()) {
        "color", "filament", "" -> WorkspaceAction.PaintKind.Color
        "support" -> WorkspaceAction.PaintKind.Support
        "seam" -> WorkspaceAction.PaintKind.Seam
        "fuzzy", "fuzzy_skin", "fuzzyskin" -> WorkspaceAction.PaintKind.FuzzySkin
        else -> null
    }

    private fun parseMergeMode(raw: String): WorkspaceAction.MergeMode? = when (raw.lowercase()) {
        "", "replace" -> WorkspaceAction.MergeMode.Replace
        "only_unpainted", "unpainted" -> WorkspaceAction.MergeMode.OnlyUnpainted
        "only_tagged", "tagged" -> WorkspaceAction.MergeMode.OnlyTagged
        else -> null
    }

    private fun maxTagFor(kind: WorkspaceAction.PaintKind): Int = when (kind) {
        WorkspaceAction.PaintKind.Color -> MAX_PAINT_SLOTS
        WorkspaceAction.PaintKind.Support -> 2
        WorkspaceAction.PaintKind.Seam -> 2
        WorkspaceAction.PaintKind.FuzzySkin -> 1
    }

    private fun arrayFor(m: PlacedModel, kind: WorkspaceAction.PaintKind): ByteArray? = when (kind) {
        WorkspaceAction.PaintKind.Color -> m.paintFilamentIndex
        WorkspaceAction.PaintKind.Support -> m.supportFlags
        WorkspaceAction.PaintKind.Seam -> m.seamFlags
        WorkspaceAction.PaintKind.FuzzySkin -> m.fuzzySkinFlags
    }

    /** Common preflight: model exists, attached, kind / merge / tag valid. */
    private suspend fun preflight(
        ws: WorkspaceModel,
        args: JSONObject,
    ): Either<ToolResult, Plan> {
        if (!ws.attached.value) {
            return Either.Left(ToolResult.error(
                "OrcaXR's main window isn't currently attached (app backgrounded?). " +
                    "Bring the app to the foreground and retry.",
            ))
        }
        val id = args.optString("model_id").trim()
        if (id.isEmpty()) return Either.Left(ToolResult.error("'model_id' is required."))
        val model = ws.placedModels.value.firstOrNull { it.id == id }
            ?: return Either.Left(ToolResult.error("No model with id '$id'."))

        val kind = parsePaintKind(args.optString("kind", "color"))
            ?: return Either.Left(ToolResult.error("Unknown kind. Use color|support|seam|fuzzy_skin."))

        val merge = parseMergeMode(args.optString("merge", "replace"))
            ?: return Either.Left(ToolResult.error("Unknown merge. Use replace|only_unpainted|only_tagged."))

        val tag = args.optInt("tag", -1)
        val maxTag = maxTagFor(kind)
        if (tag < 0 || tag > maxTag) {
            return Either.Left(ToolResult.error(
                "tag=$tag out of range for ${kind.name.lowercase()} (0..$maxTag).",
            ))
        }
        val whereTag = args.optInt("where_tag", 0)
        if (merge == WorkspaceAction.MergeMode.OnlyTagged && whereTag !in 0..maxTag) {
            return Either.Left(ToolResult.error(
                "where_tag=$whereTag out of range for ${kind.name.lowercase()} (0..$maxTag).",
            ))
        }

        val bvh = ws.getBvh(id)
            ?: return Either.Left(ToolResult.error(
                "Couldn't build a paint BVH for '$id'. Make sure the model has loaded successfully.",
            ))
        return Either.Right(Plan(model, kind, merge, tag, whereTag, bvh))
    }

    private data class Plan(
        val model: PlacedModel,
        val kind: WorkspaceAction.PaintKind,
        val merge: WorkspaceAction.MergeMode,
        val tag: Int,
        val whereTag: Int,
        val bvh: MeshBvh,
    )

    private sealed interface Either<out L, out R> {
        data class Left<L>(val value: L) : Either<L, Nothing>
        data class Right<R>(val value: R) : Either<Nothing, R>
    }

    /** Apply the merge filter without mutating: returns the indices
     *  that would actually be painted (i.e. those whose current tag
     *  matches the merge predicate). Used to compute `painted_count`
     *  for the tool response. */
    private fun applyMergeFilter(
        candidates: IntArray,
        plan: Plan,
    ): IntArray {
        val arr = arrayFor(plan.model, plan.kind)
        if (arr == null) {
            // No prior paint of this kind. OnlyTagged with where_tag=0
            // matches everything; OnlyUnpainted matches everything;
            // Replace matches everything.
            return candidates
        }
        return when (plan.merge) {
            WorkspaceAction.MergeMode.Replace -> candidates
            WorkspaceAction.MergeMode.OnlyUnpainted -> candidates.filter {
                it in arr.indices && arr[it].toInt() == 0
            }.toIntArray()
            WorkspaceAction.MergeMode.OnlyTagged -> {
                val ref = plan.whereTag.toByte()
                candidates.filter { it in arr.indices && arr[it] == ref }.toIntArray()
            }
        }
    }

    /** Build the tool result + emit the action. Returns the response. */
    private suspend fun emitAndRespond(
        ws: WorkspaceModel,
        plan: Plan,
        candidates: IntArray,
        humanLabel: String,
        extra: JSONObject = JSONObject(),
    ): ToolResult {
        val matched = candidates.size
        val effective = applyMergeFilter(candidates, plan)
        val painted = effective.size
        val truncated = effective.size > MAX_INDICES_RETURNED
        val sample = if (truncated) effective.copyOfRange(0, MAX_INDICES_RETURNED) else effective
        ws.emit(
            WorkspaceAction.PaintTriangleSet(
                modelId = plan.model.id,
                kind = plan.kind,
                triangleIndices = effective,
                tag = plan.tag,
                mergeMode = plan.merge,
                whereTag = plan.whereTag,
            ),
        )
        val body = JSONObject().apply {
            put("ok", true)
            put("model_id", plan.model.id)
            put("kind", plan.kind.name.lowercase())
            put("tag", plan.tag)
            put("merge", plan.merge.name.lowercase())
            if (plan.merge == WorkspaceAction.MergeMode.OnlyTagged) put("where_tag", plan.whereTag)
            put("triangle_count", matched)
            put("painted_count", painted)
            put("truncated_indices", truncated)
            put("triangle_indices", JSONArray().apply { for (i in sample) put(i) })
            put("total_triangle_count", plan.bvh.triCount)
            // Merge tool-specific extras (e.g. radius_mm) into the body.
            val keys = extra.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                put(k, extra.get(k))
            }
        }
        val text = "$humanLabel — matched $matched tris, painting $painted on ${plan.model.label} " +
            "(${plan.kind.name.lowercase()} tag=${plan.tag}, merge=${plan.merge.name.lowercase()})"
        return ToolResult.ok(text, body)
    }

    // ---- Tools ----

    class PaintSphere(private val ws: WorkspaceModel) : Tool {
        override val name = "paint_sphere"
        override val description =
            "Paint every triangle whose centroid is within `radius_mm` of `center` (centered_preview frame: " +
                "bbox XY-center is at (0,0,bbox_z_min), +Z up). Optional back_face_filter rejects triangles whose " +
                "outward normal points inward toward the sphere center (so a brush over the outer hull doesn't " +
                "paint the inside walls of a hollow shell). kind defaults to 'color'; tag is the filament slot " +
                "1..32 (0 = unpainted), or 0..2 for support/seam, or 0..1 for fuzzy_skin. merge controls how the " +
                "match composes with prior paint of the same kind ('replace' overwrites; 'only_unpainted' only " +
                "fills tag-0 triangles; 'only_tagged' restricts to a specific where_tag)."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "center", "radius_mm", "tag"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id from list_placed_models"),
                "kind" to Schemas.string("'color' (default) | 'support' | 'seam' | 'fuzzy_skin'"),
                "center" to Schemas.obj(
                    required = listOf("x", "y", "z"),
                    properties = mapOf(
                        "x" to Schemas.number("X in centered_preview_mm"),
                        "y" to Schemas.number("Y in centered_preview_mm"),
                        "z" to Schemas.number("Z in centered_preview_mm"),
                    ),
                ),
                "radius_mm" to Schemas.number("Sphere radius in mm"),
                "tag" to Schemas.integer("Tag to apply"),
                "merge" to Schemas.string("'replace' (default) | 'only_unpainted' | 'only_tagged'"),
                "where_tag" to Schemas.integer("Required when merge='only_tagged'"),
                "back_face_filter" to Schemas.bool("Reject triangles whose normal faces the sphere center (default false)"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val plan = when (val r = preflight(ws, args)) {
                is Either.Left -> return r.value
                is Either.Right -> r.value
            }
            val center = args.optJSONObject("center")
                ?: return ToolResult.error("'center' object with x/y/z is required.")
            val cx = center.optFloat("x") ?: return ToolResult.error("center.x missing")
            val cy = center.optFloat("y") ?: return ToolResult.error("center.y missing")
            val cz = center.optFloat("z") ?: return ToolResult.error("center.z missing")
            val radius = args.optFloat("radius_mm") ?: return ToolResult.error("'radius_mm' is required")
            if (radius <= 0f) return ToolResult.error("radius_mm must be > 0")
            val backFace = args.optBoolean("back_face_filter", false)
            val candidates = AiPaintEngine.sphere(plan.bvh, cx, cy, cz, radius, backFace)
            val extra = JSONObject().apply {
                put("center", JSONObject().apply {
                    put("x", cx.toDouble()); put("y", cy.toDouble()); put("z", cz.toDouble())
                })
                put("radius_mm", radius.toDouble())
                put("back_face_filter", backFace)
            }
            return emitAndRespond(
                ws, plan, candidates,
                "paint_sphere @($cx,$cy,$cz) r=${radius}mm",
                extra,
            )
        }
    }

    class PaintSlab(private val ws: WorkspaceModel) : Tool {
        override val name = "paint_slab"
        override val description =
            "Paint every triangle whose centroid (or vertex, see test) lies between min_mm and max_mm along the " +
                "chosen axis. Plane lives in centered_preview_mm. test='centroid' (default, fastest) checks the " +
                "centroid; 'any_vertex' accepts a triangle if at least one vertex is in range; 'all_vertices' " +
                "requires every vertex in range. axis is x|y|z. The canonical 'paint below the waterline' is " +
                "axis='z', min_mm=-1e9, max_mm=5, tag=4."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "axis", "min_mm", "max_mm", "tag"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "kind" to Schemas.string("'color' (default) | 'support' | 'seam' | 'fuzzy_skin'"),
                "axis" to Schemas.string("'x' | 'y' | 'z'"),
                "min_mm" to Schemas.number("Lower bound in mm (use a large negative for 'below')"),
                "max_mm" to Schemas.number("Upper bound in mm"),
                "test" to Schemas.string("'centroid' (default) | 'any_vertex' | 'all_vertices'"),
                "tag" to Schemas.integer("Tag to apply"),
                "merge" to Schemas.string("'replace' (default) | 'only_unpainted' | 'only_tagged'"),
                "where_tag" to Schemas.integer("Required when merge='only_tagged'"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val plan = when (val r = preflight(ws, args)) {
                is Either.Left -> return r.value
                is Either.Right -> r.value
            }
            val axisRaw = args.optString("axis", "z").lowercase()
            val axis = when (axisRaw) {
                "x" -> AiPaintEngine.Axis.X
                "y" -> AiPaintEngine.Axis.Y
                "z" -> AiPaintEngine.Axis.Z
                else -> return ToolResult.error("axis must be x|y|z, got '$axisRaw'")
            }
            val minMm = args.optFloat("min_mm") ?: return ToolResult.error("'min_mm' is required")
            val maxMm = args.optFloat("max_mm") ?: return ToolResult.error("'max_mm' is required")
            val testRaw = args.optString("test", "centroid").lowercase()
            val test = when (testRaw) {
                "", "centroid" -> AiPaintEngine.SlabTest.Centroid
                "any_vertex", "any" -> AiPaintEngine.SlabTest.AnyVertex
                "all_vertices", "all" -> AiPaintEngine.SlabTest.AllVertices
                else -> return ToolResult.error("test must be centroid|any_vertex|all_vertices")
            }
            val candidates = AiPaintEngine.slab(plan.bvh, axis, minMm, maxMm, test)
            val extra = JSONObject().apply {
                put("axis", axisRaw)
                put("min_mm", minMm.toDouble())
                put("max_mm", maxMm.toDouble())
                put("test", testRaw)
            }
            return emitAndRespond(
                ws, plan, candidates,
                "paint_slab axis=$axisRaw [$minMm..$maxMm]mm test=$testRaw",
                extra,
            )
        }
    }

    class PaintNormalCone(private val ws: WorkspaceModel) : Tool {
        override val name = "paint_normal_cone"
        override val description =
            "Paint every triangle whose outward normal makes an angle ≤ half_angle_deg with the supplied " +
                "direction. sign='outward' (default) accepts only triangles whose normal aligns with `direction`; " +
                "'inward' only triangles whose normal opposes it; 'both' matches either. Use direction=(0,0,-1), " +
                "half_angle_deg=45 to paint the underside of a model; (0,0,1), 15 to paint horizontal-ish tops only."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "direction", "half_angle_deg", "tag"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "kind" to Schemas.string("'color' (default) | 'support' | 'seam' | 'fuzzy_skin'"),
                "direction" to Schemas.obj(
                    required = listOf("x", "y", "z"),
                    properties = mapOf(
                        "x" to Schemas.number("X component"),
                        "y" to Schemas.number("Y component"),
                        "z" to Schemas.number("Z component"),
                    ),
                ),
                "half_angle_deg" to Schemas.number("Half-angle of the cone in degrees (0..90; smaller = stricter)"),
                "sign" to Schemas.string("'outward' (default) | 'inward' | 'both'"),
                "tag" to Schemas.integer("Tag to apply"),
                "merge" to Schemas.string("'replace' (default) | 'only_unpainted' | 'only_tagged'"),
                "where_tag" to Schemas.integer("Required when merge='only_tagged'"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val plan = when (val r = preflight(ws, args)) {
                is Either.Left -> return r.value
                is Either.Right -> r.value
            }
            val dir = args.optJSONObject("direction")
                ?: return ToolResult.error("'direction' object with x/y/z is required")
            val dx = dir.optFloat("x") ?: return ToolResult.error("direction.x missing")
            val dy = dir.optFloat("y") ?: return ToolResult.error("direction.y missing")
            val dz = dir.optFloat("z") ?: return ToolResult.error("direction.z missing")
            val halfAngle = args.optFloat("half_angle_deg")
                ?: return ToolResult.error("'half_angle_deg' is required")
            val signRaw = args.optString("sign", "outward").lowercase()
            val sign = when (signRaw) {
                "", "outward" -> AiPaintEngine.CooneSign.Outward
                "inward" -> AiPaintEngine.CooneSign.Inward
                "both" -> AiPaintEngine.CooneSign.Both
                else -> return ToolResult.error("sign must be outward|inward|both")
            }
            val candidates = AiPaintEngine.normalCone(plan.bvh, dx, dy, dz, halfAngle, sign)
            val extra = JSONObject().apply {
                put("direction", JSONObject().apply {
                    put("x", dx.toDouble()); put("y", dy.toDouble()); put("z", dz.toDouble())
                })
                put("half_angle_deg", halfAngle.toDouble())
                put("sign", signRaw)
            }
            return emitAndRespond(
                ws, plan, candidates,
                "paint_normal_cone dir=($dx,$dy,$dz) half=${halfAngle}° sign=$signRaw",
                extra,
            )
        }
    }

    class PaintSurfaceRegion(private val ws: WorkspaceModel) : Tool {
        override val name = "paint_surface_region"
        override val description =
            "Smart-fill from a seed triangle outward along edges whose dihedral angle is within max_dihedral_deg. " +
                "Stepwise comparison (this triangle's normal vs the candidate neighbor's normal), so the fill " +
                "traverses curved surfaces within the angle budget per step. Use a small angle (15–30°) to fill a " +
                "single curved face; a wide angle (>180°) to flood-fill the connected component. seed.tri_id " +
                "selects an exact triangle; alternatively pass a centered_preview point and a ray direction and " +
                "we raycast to find the seed."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "seed", "tag"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "kind" to Schemas.string("'color' (default) | 'support' | 'seam' | 'fuzzy_skin'"),
                "seed" to Schemas.obj(
                    properties = mapOf(
                        "tri_id" to Schemas.integer("Triangle id (0..total_triangle_count-1)"),
                        "center_mm" to Schemas.obj(
                            properties = mapOf(
                                "x" to Schemas.number(""),
                                "y" to Schemas.number(""),
                                "z" to Schemas.number(""),
                            ),
                        ),
                        "ray_dir" to Schemas.obj(
                            properties = mapOf(
                                "x" to Schemas.number(""),
                                "y" to Schemas.number(""),
                                "z" to Schemas.number(""),
                            ),
                        ),
                    ),
                ),
                "max_dihedral_deg" to Schemas.number("Default 30°. 180° = flood the whole component."),
                "max_triangles" to Schemas.integer("Hard cap on the result size (default 65536)"),
                "tag" to Schemas.integer("Tag to apply"),
                "merge" to Schemas.string("'replace' (default) | 'only_unpainted' | 'only_tagged'"),
                "where_tag" to Schemas.integer("Required when merge='only_tagged'"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val plan = when (val r = preflight(ws, args)) {
                is Either.Left -> return r.value
                is Either.Right -> r.value
            }
            val seed = args.optJSONObject("seed")
                ?: return ToolResult.error("'seed' object is required")
            val seedTri = resolveSeed(plan.bvh, seed)
                ?: return ToolResult.error("Couldn't resolve seed — provide tri_id, or center_mm + ray_dir.")
            val maxDihedral = args.optFloat("max_dihedral_deg") ?: 30f
            val maxTriangles = args.optInt("max_triangles", 65_536)
            val candidates = AiPaintEngine.surfaceRegion(
                plan.bvh, seedTri, maxDihedral, maxTriangles.coerceIn(1, 1_500_000),
            )
            val extra = JSONObject().apply {
                put("seed_tri_id", seedTri)
                put("max_dihedral_deg", maxDihedral.toDouble())
                put("max_triangles", maxTriangles)
            }
            return emitAndRespond(
                ws, plan, candidates,
                "paint_surface_region seed=$seedTri dihedral=${maxDihedral}°",
                extra,
            )
        }
    }

    class PaintConnectedComponent(private val ws: WorkspaceModel) : Tool {
        override val name = "paint_connected_component"
        override val description =
            "Paint the entire connected sub-mesh containing the seed triangle (vertex-adjacency BFS, no angle " +
                "gate). Useful when the model is actually multiple disjoint meshes (e.g. some Benchy STLs have " +
                "the smokestack as a separate component from the hull) — this paints just the chosen one."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "seed", "tag"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "kind" to Schemas.string("'color' (default) | 'support' | 'seam' | 'fuzzy_skin'"),
                "seed" to Schemas.obj(
                    properties = mapOf(
                        "tri_id" to Schemas.integer(""),
                        "center_mm" to Schemas.obj(),
                        "ray_dir" to Schemas.obj(),
                    ),
                ),
                "max_triangles" to Schemas.integer("Hard cap (default 1_500_000)"),
                "tag" to Schemas.integer("Tag to apply"),
                "merge" to Schemas.string("'replace' (default) | 'only_unpainted' | 'only_tagged'"),
                "where_tag" to Schemas.integer("Required when merge='only_tagged'"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val plan = when (val r = preflight(ws, args)) {
                is Either.Left -> return r.value
                is Either.Right -> r.value
            }
            val seed = args.optJSONObject("seed")
                ?: return ToolResult.error("'seed' object is required")
            val seedTri = resolveSeed(plan.bvh, seed)
                ?: return ToolResult.error("Couldn't resolve seed — provide tri_id, or center_mm + ray_dir.")
            val maxTriangles = args.optInt("max_triangles", 1_500_000)
            val candidates = AiPaintEngine.connectedComponent(
                plan.bvh, seedTri, maxTriangles.coerceIn(1, 5_000_000),
            )
            val extra = JSONObject().apply {
                put("seed_tri_id", seedTri)
                put("max_triangles", maxTriangles)
            }
            return emitAndRespond(
                ws, plan, candidates,
                "paint_connected_component seed=$seedTri",
                extra,
            )
        }
    }

    class PaintTriangleList(private val ws: WorkspaceModel) : Tool {
        override val name = "paint_triangle_list"
        override val description =
            "Apply a tag to a precomputed list of triangle ids. The lowest-level primitive — used as an escape " +
                "hatch when the LLM has done its own analysis (e.g. it called render_triangle_id_map and decoded " +
                "the PNG) or wants to chain primitive results together. Out-of-range ids are silently dropped " +
                "(the response surfaces a count). Capped at 65536 ids per call."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "triangle_ids", "tag"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "kind" to Schemas.string("'color' (default) | 'support' | 'seam' | 'fuzzy_skin'"),
                "triangle_ids" to JSONObject().apply {
                    put("type", "array")
                    put("description", "Triangle ids (0..total_triangle_count-1)")
                    put("items", Schemas.integer(""))
                },
                "tag" to Schemas.integer("Tag to apply"),
                "merge" to Schemas.string("'replace' (default) | 'only_unpainted' | 'only_tagged'"),
                "where_tag" to Schemas.integer("Required when merge='only_tagged'"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val plan = when (val r = preflight(ws, args)) {
                is Either.Left -> return r.value
                is Either.Right -> r.value
            }
            val arr = args.optJSONArray("triangle_ids")
                ?: return ToolResult.error("'triangle_ids' array is required")
            if (arr.length() > 65_536) {
                return ToolResult.error("triangle_ids capped at 65536 entries; got ${arr.length()}.")
            }
            val ids = IntArray(arr.length()) { arr.optInt(it, -1) }
            val result = AiPaintEngine.triangleList(plan.bvh.triCount, ids)
            val extra = JSONObject().apply {
                put("dropped_out_of_range", result.droppedOutOfRange)
                put("input_count", ids.size)
            }
            return emitAndRespond(
                ws, plan, result.indices,
                "paint_triangle_list (${result.indices.size} ids" +
                    if (result.droppedOutOfRange > 0) ", ${result.droppedOutOfRange} dropped)" else ")",
                extra,
            )
        }
    }

    class PaintProjectedMask(private val ws: WorkspaceModel) : Tool {
        override val name = "paint_projected_mask"
        override val description =
            "Reverse-project a 2D mask through a camera onto the model's surface. The mask is " +
                "authored as a polygon list in pixel coords matching the camera's width/height — " +
                "for each 'on' pixel we cast a ray from the camera through it and paint the " +
                "triangle(s) it hits. depth_mode='front_facing_only' (default) paints only the " +
                "front-most triangle along each ray; 'all_hits' paints both sides of a thin shell. " +
                "back_face_filter=true (default) drops triangles whose normal faces away from the " +
                "camera. The camera_descriptor must come from a render_view tool result so the " +
                "tool's pixel space matches the rendered image. Recorded as one PaintTriangleSet so " +
                "the result is undoable in a single paint_undo step."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "camera_descriptor", "polygons", "tag"),
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
                "polygons" to JSONObject().apply {
                    put("type", "array")
                    put("description", "List of polygons; each polygon is a flat array of pixel coords [x1, y1, x2, y2, ...]")
                    put("items", JSONObject().apply {
                        put("type", "array")
                        put("items", Schemas.number(""))
                    })
                },
                "depth_mode" to Schemas.string("'front_facing_only' (default) | 'any_facing' (catches curvature wraparound) | 'all_hits'"),
                "back_face_filter" to Schemas.bool("Reject hits whose normal faces away from the camera (default true)"),
                "tag" to Schemas.integer("Tag to apply"),
                "merge" to Schemas.string("'replace' (default) | 'only_unpainted' | 'only_tagged'"),
                "where_tag" to Schemas.integer("Required when merge='only_tagged'"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val plan = when (val r = preflight(ws, args)) {
                is Either.Left -> return r.value
                is Either.Right -> r.value
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
            if (w > 1024 || h > 1024) return ToolResult.error("camera dims capped at 1024 each")
            val polysRaw = args.optJSONArray("polygons")
                ?: return ToolResult.error("'polygons' array required")
            val polys = ArrayList<FloatArray>(polysRaw.length())
            for (i in 0 until polysRaw.length()) {
                val p = polysRaw.optJSONArray(i) ?: continue
                if (p.length() % 2 != 0 || p.length() < 4) {
                    return ToolResult.error("polygon $i must have an even number of coords ≥ 4")
                }
                val arr = FloatArray(p.length()) { p.optDouble(it, 0.0).toFloat() }
                polys.add(arr)
            }
            if (polys.isEmpty()) return ToolResult.error("at least one non-empty polygon required")
            val depthRaw = args.optString("depth_mode", "front_facing_only").lowercase()
            val depth = when (depthRaw) {
                "", "front_facing_only", "front" -> dev.orcaxr.app.AiMaskProjection.DepthMode.FrontFacingOnly
                "all_hits", "all" -> dev.orcaxr.app.AiMaskProjection.DepthMode.AllHits
                // D18d — keep all front-facing tris along the ray
                // (lit hemisphere), catching wraparound on bulges.
                "any_facing", "any", "lit" -> dev.orcaxr.app.AiMaskProjection.DepthMode.AnyFacing
                else -> return ToolResult.error(
                    "depth_mode must be front_facing_only|all_hits|any_facing",
                )
            }
            val backFace = args.optBoolean("back_face_filter", true)
            val viewArr = FloatArray(16) { view.optDouble(it, 0.0).toFloat() }
            val projArr = FloatArray(16) { proj.optDouble(it, 0.0).toFloat() }
            val camera = dev.orcaxr.app.AiRenderEngine.CameraSpec(viewArr, projArr, w, h)
            val mask = dev.orcaxr.app.AiMaskProjection.rasterizePolygons(polys, w, h)
            val candidates = dev.orcaxr.app.AiMaskProjection.project(
                bvh = plan.bvh,
                camera = camera,
                mask = mask,
                depthMode = depth,
                backFaceFilter = backFace,
            )
            val onPixels = mask.count { it }
            val extra = JSONObject().apply {
                put("polygon_count", polys.size)
                put("mask_on_pixels", onPixels)
                put("depth_mode", depthRaw)
                put("back_face_filter", backFace)
            }
            return emitAndRespond(
                ws, plan, candidates,
                "paint_projected_mask (${polys.size} polygons, $onPixels pixels)",
                extra,
            )
        }
    }

    class PaintWithMirror(
        private val ws: WorkspaceModel,
        private val innerTools: List<Tool>,
    ) : Tool {
        override val name = "paint_with_mirror"
        override val description =
            "Apply a paint primitive AND its mirror across a bbox-center axis in one call. Axis is " +
                "'x' | 'y' | 'z'; the mirror plane is the model's bbox center on that axis. Two " +
                "PaintTriangleSet actions are emitted (one per side) so paint_undo walks back each " +
                "side independently. Useful for paired bilateral features (Pikachu eyes / cheeks / " +
                "ears, Funko Pop eyes, eyes on ANY symmetric figure). Inner tool can be: " +
                "paint_sphere, paint_slab, paint_normal_cone, paint_geodesic_disc, " +
                "paint_surface_region, paint_connected_component, paint_triangle_list, " +
                "paint_projected_mask (X-mirror only). Args are passed through verbatim with the " +
                "spatial fields mirrored: center / direction / anchor / polygon X coords / triangle " +
                "ids (via centroid-mirror + nearest-tri lookup)."
        override val inputSchema = Schemas.obj(
            required = listOf("axis", "inner"),
            properties = mapOf(
                "axis" to Schemas.string("'x' | 'y' | 'z' — bbox-center axis to mirror across"),
                "inner" to Schemas.obj(
                    required = listOf("tool", "arguments"),
                    properties = mapOf(
                        "tool" to Schemas.string("Inner paint tool name"),
                        "arguments" to Schemas.obj(),
                    ),
                ),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
            val axisRaw = args.optString("axis").lowercase()
            val axisIdx = when (axisRaw) {
                "x" -> 0; "y" -> 1; "z" -> 2
                else -> return ToolResult.error("axis must be x|y|z, got '$axisRaw'")
            }
            val inner = args.optJSONObject("inner")
                ?: return ToolResult.error("'inner' object is required")
            val innerToolName = inner.optString("tool")
            if (innerToolName.isEmpty()) return ToolResult.error("inner.tool name is required")
            val innerTool = innerTools.firstOrNull { it.name == innerToolName }
                ?: return ToolResult.error("Unknown inner tool '$innerToolName'.")
            val innerArgs = inner.optJSONObject("arguments")
                ?: return ToolResult.error("inner.arguments object required")
            val modelId = innerArgs.optString("model_id")
            if (modelId.isEmpty()) return ToolResult.error("inner.arguments.model_id required")
            if (ws.placedModels.value.none { it.id == modelId }) {
                return ToolResult.error("No model with id '$modelId'.")
            }
            val bvh = ws.getBvh(modelId)
                ?: return ToolResult.error("Couldn't build BVH for '$modelId'.")
            val geom = dev.orcaxr.app.AiIntrospection.geometry(bvh, bins = 1)
            val centerOnAxis = when (axisIdx) {
                0 -> geom.bboxCenteredPreview.centerX
                1 -> geom.bboxCenteredPreview.centerY
                else -> geom.bboxCenteredPreview.centerZ
            }

            // Pass 1: original.
            val r1 = innerTool.call(innerArgs)
            if (r1.isError) return ToolResult.error("Inner pass 1 failed: ${r1.text}")

            // Pass 2: mirrored.
            val mirroredArgs = mirrorArgs(innerArgs, axisIdx, centerOnAxis, bvh, innerToolName)
                ?: return ToolResult.error(
                    "Couldn't mirror inner args for '$innerToolName' across axis '$axisRaw'.",
                )
            val r2 = innerTool.call(mirroredArgs)

            val s1 = r1.structured?.optInt("painted_count", 0) ?: 0
            val s2 = r2.structured?.optInt("painted_count", 0) ?: 0
            val body = JSONObject().apply {
                put("ok", true)
                put("axis", axisRaw)
                put("inner_tool", innerToolName)
                put("painted_count_a", s1)
                put("painted_count_b", s2)
                put("painted_count_total", s1 + s2)
                if (r1.structured != null) put("pass_a", r1.structured)
                if (r2.structured != null) put("pass_b", r2.structured)
                if (r2.isError) put("pass_b_error", r2.text)
            }
            val text = "paint_with_mirror axis=$axisRaw via $innerToolName " +
                "(a: $s1 painted, b: $s2 painted${if (r2.isError) " — pass B errored" else ""})"
            return ToolResult.ok(text, body)
        }

        /** Deep-clone via JSON serialize+parse (org.json has no
         *  built-in deep clone). */
        private fun cloneJson(o: JSONObject): JSONObject = JSONObject(o.toString())

        private fun mirrorArgs(
            args: JSONObject,
            axisIdx: Int,
            c: Float,
            bvh: MeshBvh,
            innerName: String,
        ): JSONObject? {
            val out = cloneJson(args)
            val key = arrayOf("x", "y", "z")[axisIdx]
            when (innerName) {
                "paint_sphere" -> {
                    val center = out.optJSONObject("center") ?: return null
                    val v = center.optDouble(key)
                    center.put(key, 2.0 * c - v)
                }
                "paint_normal_cone" -> {
                    val dir = out.optJSONObject("direction") ?: return null
                    val v = dir.optDouble(key)
                    // Direction is a vector, not a point — flip the
                    // chosen axis component, no center offset.
                    dir.put(key, -v)
                }
                "paint_slab" -> {
                    val slabAxis = out.optString("axis", "z").lowercase()
                    if (slabAxis == key) {
                        // Axis matches: mirror the [min, max] interval
                        // around the bbox center.
                        val lo = out.optDouble("min_mm")
                        val hi = out.optDouble("max_mm")
                        out.put("min_mm", 2.0 * c - hi)
                        out.put("max_mm", 2.0 * c - lo)
                    }
                    // Different axis: slab is full-mesh on other
                    // axes, no spatial change needed.
                }
                "paint_geodesic_disc" -> mirrorAnchor(out, "anchor", axisIdx, c, bvh) ?: return null
                "paint_surface_region", "paint_connected_component" ->
                    mirrorAnchor(out, "seed", axisIdx, c, bvh) ?: return null
                "paint_projected_mask" -> {
                    if (axisIdx != 0) return null  // X-only for v1
                    val cd = out.optJSONObject("camera_descriptor") ?: return null
                    val w = cd.optInt("width_px", 0)
                    if (w <= 0) return null
                    val polys = out.optJSONArray("polygons") ?: return null
                    val mirrored = JSONArray()
                    for (i in 0 until polys.length()) {
                        val p = polys.optJSONArray(i) ?: continue
                        val mp = JSONArray()
                        var j = 0
                        while (j + 1 < p.length()) {
                            val x = p.optDouble(j)
                            val y = p.optDouble(j + 1)
                            mp.put(w - 1 - x); mp.put(y)
                            j += 2
                        }
                        mirrored.put(mp)
                    }
                    out.put("polygons", mirrored)
                }
                "paint_triangle_list" -> {
                    val ids = out.optJSONArray("triangle_ids") ?: return null
                    val mirrored = JSONArray()
                    for (i in 0 until ids.length()) {
                        val mt = mirrorTriangleId(bvh, ids.optInt(i, -1), axisIdx, c) ?: continue
                        mirrored.put(mt)
                    }
                    out.put("triangle_ids", mirrored)
                }
                else -> return null
            }
            return out
        }

        /** Mirror an anchor field (`anchor` for geodesic_disc,
         *  `seed` for surface_region / connected_component). Returns
         *  Unit on success, null on failure. */
        private fun mirrorAnchor(
            out: JSONObject,
            fieldName: String,
            axisIdx: Int,
            c: Float,
            bvh: MeshBvh,
        ): Unit? {
            val anchor = out.optJSONObject(fieldName) ?: return null
            val key = arrayOf("x", "y", "z")[axisIdx]
            if (anchor.has("tri_id")) {
                val tri = anchor.optInt("tri_id", -1)
                val mt = mirrorTriangleId(bvh, tri, axisIdx, c) ?: return null
                anchor.put("tri_id", mt)
            } else if (anchor.has("center_mm")) {
                val cm = anchor.optJSONObject("center_mm") ?: return null
                val v = cm.optDouble(key)
                cm.put(key, 2.0 * c - v)
                // Mirror ray_dir if present (it's a vector).
                anchor.optJSONObject("ray_dir")?.let { rd ->
                    val rv = rd.optDouble(key)
                    rd.put(key, -rv)
                }
            } else {
                // camera_descriptor + pixel — too many degrees of
                // freedom (camera basis can be arbitrary). For the v1
                // shipping cut, the LLM should re-cite a tri_id or
                // center_mm anchor when using paint_with_mirror.
                return null
            }
            return Unit
        }

        /** Centroid-mirror + nearest-centroid search. O(triCount) per
         *  call — fine for one-shot mirror. */
        private fun mirrorTriangleId(bvh: MeshBvh, tri: Int, axisIdx: Int, c: Float): Int? {
            if (tri < 0 || tri >= bvh.triCount) return null
            val centroid = bvh.triangleCentroid(tri)
            val mx = if (axisIdx == 0) 2 * c - centroid.x else centroid.x
            val my = if (axisIdx == 1) 2 * c - centroid.y else centroid.y
            val mz = if (axisIdx == 2) 2 * c - centroid.z else centroid.z
            var best = -1
            var bestDist = Float.POSITIVE_INFINITY
            for (i in 0 until bvh.triCount) {
                val tc = bvh.triangleCentroid(i)
                val dx = tc.x - mx; val dy = tc.y - my; val dz = tc.z - mz
                val d = dx * dx + dy * dy + dz * dz
                if (d < bestDist) { bestDist = d; best = i }
            }
            return if (best >= 0) best else null
        }
    }

    /** Resolve a seed JSON description to a triangle index. Accepts:
     *  - `{tri_id: int}` — exact
     *  - `{center_mm, ray_dir}` — ray from a 3D point in mesh frame
     *  - `{camera_descriptor, x_px, y_px}` — pixel pick via the
     *    same unprojection paint_projected_mask uses (D18a — lets
     *    the LLM chain render_triangle_id_map → click pixel → paint
     *    geodesic disc anchored on that pixel). */
    private fun resolveSeed(bvh: MeshBvh, seed: JSONObject): Int? {
        if (seed.has("tri_id")) {
            val t = seed.optInt("tri_id", -1)
            if (t < 0 || t >= bvh.triCount) return null
            return t
        }
        if (seed.has("camera_descriptor") && seed.has("x_px") && seed.has("y_px")) {
            val cd = seed.optJSONObject("camera_descriptor") ?: return null
            val view = cd.optJSONArray("view_matrix_4x4") ?: return null
            val proj = cd.optJSONArray("projection_matrix_4x4") ?: return null
            if (view.length() != 16 || proj.length() != 16) return null
            val w = cd.optInt("width_px", 0)
            val h = cd.optInt("height_px", 0)
            if (w <= 0 || h <= 0) return null
            val viewArr = FloatArray(16) { view.optDouble(it, 0.0).toFloat() }
            val projArr = FloatArray(16) { proj.optDouble(it, 0.0).toFloat() }
            val cam = dev.orcaxr.app.AiRenderEngine.CameraSpec(viewArr, projArr, w, h)
            val xPx = seed.optInt("x_px", -1)
            val yPx = seed.optInt("y_px", -1)
            return dev.orcaxr.app.AiMaskProjection.pickTriangleAtPixel(bvh, cam, xPx, yPx)
        }
        val center = seed.optJSONObject("center_mm") ?: return null
        val dir = seed.optJSONObject("ray_dir")
        val ox = center.optFloat("x") ?: return null
        val oy = center.optFloat("y") ?: return null
        val oz = center.optFloat("z") ?: return null
        // Default ray dir is -Z (top-down) so a `center_mm` from
        // outside the bbox top will hit the surface naturally.
        val dx = dir?.optFloat("x") ?: 0f
        val dy = dir?.optFloat("y") ?: 0f
        val dz = dir?.optFloat("z") ?: -1f
        return bvh.intersect(
            dev.orcaxr.app.Vec3f(ox, oy, oz),
            dev.orcaxr.app.Vec3f(dx, dy, dz),
        )
    }

    class PaintGeodesicDisc(private val ws: WorkspaceModel) : Tool {
        override val name = "paint_geodesic_disc"
        override val description =
            "Paint a connected disc on the mesh SURFACE outward from a seed triangle, bounded by " +
                "geodesic distance (centroid-hop sum, NOT euclidean) and stopped at sharp curvature " +
                "edges via a per-step dihedral gate. The right primitive for 'paint the cheek bump' / " +
                "'paint the eye / nose / ear-interior' on a curved organic mesh — paint_projected_mask " +
                "back-face-filters out the wraparound on a bulge, geodesic-disc walks across it. Use " +
                "max_dihedral_deg≈60° to wrap a hemisphere bulge; ≈30° to stay near-planar (one face " +
                "of a chamfered solid); 180° to ignore curvature and use radius alone. Returns " +
                "triangles in geodesic-distance order so the result is robust against the radius " +
                "barely-clipping a sharp triangle."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "anchor", "radius_mm", "tag"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "kind" to Schemas.string("'color' (default) | 'support' | 'seam' | 'fuzzy_skin'"),
                "anchor" to Schemas.obj(
                    properties = mapOf(
                        "tri_id" to Schemas.integer("Exact seed triangle id"),
                        "center_mm" to Schemas.obj(
                            properties = mapOf(
                                "x" to Schemas.number(""),
                                "y" to Schemas.number(""),
                                "z" to Schemas.number(""),
                            ),
                        ),
                        "ray_dir" to Schemas.obj(
                            properties = mapOf(
                                "x" to Schemas.number(""),
                                "y" to Schemas.number(""),
                                "z" to Schemas.number(""),
                            ),
                        ),
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
                        "x_px" to Schemas.integer("Pixel x (with camera_descriptor)"),
                        "y_px" to Schemas.integer("Pixel y (with camera_descriptor)"),
                    ),
                ),
                "radius_mm" to Schemas.number("Geodesic radius in mm (NOT euclidean)"),
                "max_dihedral_deg" to Schemas.number("Per-step dihedral gate (default 60°)"),
                "max_triangles" to Schemas.integer("Hard cap on the result size (default 65536)"),
                "tag" to Schemas.integer("Tag to apply"),
                "merge" to Schemas.string("'replace' (default) | 'only_unpainted' | 'only_tagged'"),
                "where_tag" to Schemas.integer("Required when merge='only_tagged'"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val plan = when (val r = preflight(ws, args)) {
                is Either.Left -> return r.value
                is Either.Right -> r.value
            }
            val anchor = args.optJSONObject("anchor")
                ?: return ToolResult.error("'anchor' object is required")
            val seedTri = resolveSeed(plan.bvh, anchor)
                ?: return ToolResult.error("Couldn't resolve anchor — provide tri_id, or center_mm + ray_dir, or camera_descriptor + x_px + y_px.")
            val radius = args.optFloat("radius_mm")
                ?: return ToolResult.error("'radius_mm' is required")
            if (radius <= 0f) return ToolResult.error("radius_mm must be > 0")
            val maxDihedral = args.optFloat("max_dihedral_deg") ?: 60f
            val maxTriangles = args.optInt("max_triangles", 65_536).coerceIn(1, 1_500_000)
            val candidates = dev.orcaxr.app.AiPaintEngine.geodesicDisc(
                plan.bvh, seedTri, radius, maxDihedral, maxTriangles,
            )
            val extra = JSONObject().apply {
                put("seed_tri_id", seedTri)
                put("radius_mm", radius.toDouble())
                put("max_dihedral_deg", maxDihedral.toDouble())
                put("max_triangles", maxTriangles)
            }
            return emitAndRespond(
                ws, plan, candidates,
                "paint_geodesic_disc seed=$seedTri r=${radius}mm dihedral=${maxDihedral}°",
                extra,
            )
        }
    }

    // ---- JSON helpers — duplicated tiny helpers from WorkspaceTools.kt
    //                    so AiPaintTools is self-contained without
    //                    making the existing internal helpers public. ----

    private fun JSONObject.optFloat(key: String): Float? {
        if (!has(key)) return null
        val v = opt(key)
        return when (v) {
            is Number -> v.toFloat()
            is String -> v.toFloatOrNull()
            else -> null
        }
    }
}
