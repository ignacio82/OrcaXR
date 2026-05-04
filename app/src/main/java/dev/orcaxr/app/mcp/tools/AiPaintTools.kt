package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiPaintEngine
import dev.orcaxr.app.MAX_PAINT_SLOTS
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.mcp.AiPaintSession
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
 *   - `total_triangle_count`: total tris on the model
 *   - `triangle_indices` + `truncated_indices`: ONLY when the caller
 *     opts in via `return_indices=true`. Default off (since 2026-05)
 *     to keep tool responses small — most workflows verify with
 *     `paint_coverage_summary` / `get_paint_summary` instead.
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

    /**
     * Outcome of [resolveTag]. Splitting the success/failure path lets
     * callers emit a tool-specific message context without juggling
     * nullable Ints.
     */
    private sealed interface TagResult {
        data class Resolved(val tag: Int) : TagResult
        data class Error(val message: String) : TagResult
    }

    /** Common color names → canonical hex, used to resolve a name like
     *  "white" against the active filament palette. Keep small + obvious
     *  — the palette is the source of truth, this is just the bridge for
     *  natural-language LLM input. */
    private val NAMED_COLOR_HEX: Map<String, String> = mapOf(
        "white" to "#FFFFFF",
        "black" to "#000000",
        "red" to "#FF0000",
        "green" to "#008000",
        "lime" to "#00FF00",
        "blue" to "#0000FF",
        "yellow" to "#FFFF00",
        "orange" to "#FF8000",
        "cyan" to "#00FFFF",
        "magenta" to "#FF00FF",
        "pink" to "#FFC0CB",
        "purple" to "#800080",
        "violet" to "#8A2BE2",
        "brown" to "#8B4513",
        "gray" to "#808080",
        "grey" to "#808080",
        "silver" to "#C0C0C0",
        "gold" to "#FFD700",
    )

    private val NON_COLOR_TAG_NAMES: Map<WorkspaceAction.PaintKind, Map<String, Int>> = mapOf(
        WorkspaceAction.PaintKind.Support to mapOf(
            "none" to 0, "unpainted" to 0, "off" to 0,
            "enforcer" to 1, "force" to 1, "on" to 1,
            "blocker" to 2, "block" to 2, "off_force" to 2,
        ),
        WorkspaceAction.PaintKind.Seam to mapOf(
            "none" to 0, "unpainted" to 0, "off" to 0,
            "enforcer" to 1, "force" to 1, "on" to 1,
            "blocker" to 2, "block" to 2,
        ),
        WorkspaceAction.PaintKind.FuzzySkin to mapOf(
            "none" to 0, "off" to 0, "unpainted" to 0,
            "fuzzy" to 1, "on" to 1, "enabled" to 1,
        ),
    )

    /**
     * Resolve a `tag` argument from any of the shapes the LLM might emit:
     *
     *   - integer in range            → use as-is
     *   - string of digits            → parsed as int
     *   - color name ("white")        → matched against the active palette
     *   - hex literal ("#FFFFFF")     → matched against the active palette
     *   - named flag ("enforcer")     → only valid for support/seam/fuzzy_skin
     *
     * Closest-palette match uses RGB Euclidean distance with a generous
     * threshold; if the palette has no plausible match (or is empty),
     * we fail with a message that includes the actual palette so the
     * model can pick a numeric tag in its retry.
     */
    private fun resolveTag(
        raw: Any?,
        kind: WorkspaceAction.PaintKind,
        ws: WorkspaceModel,
        maxTag: Int,
        defaultZero: Boolean = false,
    ): TagResult {
        // Default for omitted args: tag 0 means "unpainted" / matches the
        // optInt(..., -1) / 0 historic behavior. where_tag uses 0; tag
        // requires explicit value.
        if (raw == null || raw == JSONObject.NULL) {
            return if (defaultZero) TagResult.Resolved(0)
            else TagResult.Error(
                "'tag' is required (integer 0..$maxTag, color name like \"white\", or hex like \"#FFFFFF\").",
            )
        }

        // Integer (or numeric string).
        val asInt =
            when (raw) {
                is Int -> raw
                is Long -> raw.toInt()
                is Number -> raw.toInt()
                is String -> raw.trim().toIntOrNull()
                else -> null
            }
        if (asInt != null) {
            return if (asInt in 0..maxTag) TagResult.Resolved(asInt)
            else TagResult.Error("tag=$asInt out of range for ${kind.name.lowercase()} (0..$maxTag).")
        }

        if (raw !is String) {
            return TagResult.Error("'tag' must be an integer or a color name; got ${raw::class.simpleName}.")
        }

        val token = raw.trim().lowercase()

        // Non-color kinds: resolve named flags (enforcer / blocker / fuzzy / off …).
        if (kind != WorkspaceAction.PaintKind.Color) {
            val map = NON_COLOR_TAG_NAMES[kind] ?: emptyMap()
            map[token]?.let {
                return if (it <= maxTag) TagResult.Resolved(it)
                else TagResult.Error("tag '$token'=$it out of range (0..$maxTag).")
            }
            return TagResult.Error(
                "'$token' isn't a recognised ${kind.name.lowercase()} flag. " +
                    "Use ${(map.keys.sorted()).joinToString(", ")} or an integer 0..$maxTag.",
            )
        }

        // Color kind: name → hex → closest palette slot.
        val palette = ws.previewPalette.value
        if (palette.isEmpty()) {
            return TagResult.Error(
                "Active palette is empty (no printer selected, or filament list not loaded). " +
                    "Either select a printer in OrcaXR or pass an integer tag (1..$maxTag).",
            )
        }
        val targetHex = NAMED_COLOR_HEX[token] ?: token.takeIf { it.startsWith("#") || token.length == 6 }
        if (targetHex == null) {
            return TagResult.Error(
                "'$token' isn't a known color name. Try one of: " +
                    NAMED_COLOR_HEX.keys.sorted().joinToString(", ") +
                    "; or a hex like \"#FFFFFF\"; or an integer tag 1..$maxTag.",
            )
        }
        val target = parseHex(targetHex)
            ?: return TagResult.Error("Couldn't parse '$targetHex' as a color.")
        var bestSlot = -1
        var bestDist = Int.MAX_VALUE
        for ((idx, hex) in palette.withIndex()) {
            val rgb = parseHex(hex) ?: continue
            val d = colorDistanceSq(target, rgb)
            if (d < bestDist) {
                bestDist = d
                bestSlot = idx
            }
        }
        if (bestSlot < 0) {
            return TagResult.Error(
                "Couldn't match '$token' to any palette entry. Active palette: " +
                    palette.joinToString(", "),
            )
        }
        // Tag = slot_index + 1 (tag 0 reserved for unpainted).
        val tag = bestSlot + 1
        return if (tag in 0..maxTag) TagResult.Resolved(tag)
        else TagResult.Error("Resolved tag $tag is out of range (0..$maxTag).")
    }

    private fun parseHex(s: String): IntArray? {
        val h = s.removePrefix("#").trim()
        if (h.length != 6) return null
        return runCatching {
                intArrayOf(
                    h.substring(0, 2).toInt(16),
                    h.substring(2, 4).toInt(16),
                    h.substring(4, 6).toInt(16),
                )
            }
            .getOrNull()
    }

    private fun colorDistanceSq(a: IntArray, b: IntArray): Int {
        val dr = a[0] - b[0]
        val dg = a[1] - b[1]
        val db = a[2] - b[2]
        return dr * dr + dg * dg + db * db
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

        val maxTag = maxTagFor(kind)
        val tag =
            when (val resolved = resolveTag(args.opt("tag"), kind, ws, maxTag)) {
                is TagResult.Resolved -> resolved.tag
                is TagResult.Error -> return Either.Left(ToolResult.error(resolved.message))
            }
        val whereTag =
            when (val resolved = resolveTag(args.opt("where_tag"), kind, ws, maxTag, defaultZero = true)) {
                is TagResult.Resolved -> resolved.tag
                is TagResult.Error -> return Either.Left(ToolResult.error(resolved.message))
            }
        if (merge == WorkspaceAction.MergeMode.OnlyTagged && whereTag !in 0..maxTag) {
            return Either.Left(ToolResult.error(
                "where_tag=$whereTag out of range for ${kind.name.lowercase()} (0..$maxTag).",
            ))
        }

        val bvh = ws.getBvh(id)
            ?: return Either.Left(ToolResult.error(
                "Couldn't build a paint BVH for '$id'. Make sure the model has loaded successfully.",
            ))

        // C9 milestone 4 — optional session_id routes the paint into a
        // headless scratch buffer instead of the live model. Mismatched
        // session/model fails closed (the LLM probably has the wrong
        // session id).
        val session = when (val r = PaintSessionTools.resolveSession(args, id)) {
            PaintSessionTools.SessionResolution.NotRequested -> null
            is PaintSessionTools.SessionResolution.Found -> r.session
            is PaintSessionTools.SessionResolution.Error ->
                return Either.Left(ToolResult.error(r.message))
        }
        if (session != null && session.triCount != bvh.triCount) {
            return Either.Left(ToolResult.error(
                "Session ${session.id} was opened with tri_count=${session.triCount} but the live " +
                    "model now has tri_count=${bvh.triCount}. A mesh-mutating action invalidated " +
                    "this session — call discard_paint_session and start a new one.",
            ))
        }
        return Either.Right(Plan(model, kind, merge, tag, whereTag, bvh, session))
    }

    private data class Plan(
        val model: PlacedModel,
        val kind: WorkspaceAction.PaintKind,
        val merge: WorkspaceAction.MergeMode,
        val tag: Int,
        val whereTag: Int,
        val bvh: MeshBvh,
        /** When non-null, paint flows into the session's scratch
         *  ByteArray and no [WorkspaceAction] is emitted. */
        val session: AiPaintSession?,
    )

    private sealed interface Either<out L, out R> {
        data class Left<L>(val value: L) : Either<L, Nothing>
        data class Right<R>(val value: R) : Either<Nothing, R>
    }

    /** Apply the merge filter without mutating: returns the indices
     *  that would actually be painted (i.e. those whose current tag
     *  matches the merge predicate). Used to compute `painted_count`
     *  for the tool response.
     *
     *  When the plan targets a session, the filter reads the session's
     *  scratch buffer instead of the live model so chained
     *  only_unpainted / only_tagged calls inside a session compose
     *  correctly. */
    private fun applyMergeFilter(
        candidates: IntArray,
        plan: Plan,
    ): IntArray {
        val arr = plan.session?.arrayFor(plan.kind) ?: arrayFor(plan.model, plan.kind)
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

    /** Build the tool result + emit the action. Returns the response.
     *  Set [returnIndices] true to include the actual `triangle_indices`
     *  array (capped at [MAX_INDICES_RETURNED]); when false (the
     *  default) we omit the array entirely to keep responses small —
     *  most LLM workflows verify with `paint_coverage_summary` /
     *  `get_paint_summary` instead of consuming raw indices.
     *
     *  Session-aware: when [Plan.session] is non-null the merge +
     *  apply happens against the session's scratch buffer in-process
     *  (no [WorkspaceAction] emitted, no scene rebake). The response
     *  body's [`session_id`] field signals the headless path. */
    private suspend fun emitAndRespond(
        ws: WorkspaceModel,
        plan: Plan,
        candidates: IntArray,
        humanLabel: String,
        extra: JSONObject = JSONObject(),
        returnIndices: Boolean = false,
    ): ToolResult {
        val matched = candidates.size
        val effective = applyMergeFilter(candidates, plan)
        val painted: Int
        val session = plan.session
        if (session != null) {
            // Headless path: mutate session in place.
            painted = session.applyTriangleSet(
                kind = plan.kind,
                indices = effective,
                tag = plan.tag,
                mergeMode = plan.merge,
                whereTag = plan.whereTag,
            )
        } else {
            painted = effective.size
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
        }
        val body = JSONObject().apply {
            put("ok", true)
            put("model_id", plan.model.id)
            put("kind", plan.kind.name.lowercase())
            put("tag", plan.tag)
            put("merge", plan.merge.name.lowercase())
            if (plan.merge == WorkspaceAction.MergeMode.OnlyTagged) put("where_tag", plan.whereTag)
            put("triangle_count", matched)
            put("painted_count", painted)
            put("total_triangle_count", plan.bvh.triCount)
            if (session != null) {
                put("session_id", session.id)
                put("session_version", session.version)
                put("session_total_actions", session.totalActions)
            }
            if (returnIndices) {
                val truncated = effective.size > MAX_INDICES_RETURNED
                val sample = if (truncated) effective.copyOfRange(0, MAX_INDICES_RETURNED) else effective
                put("truncated_indices", truncated)
                put("triangle_indices", JSONArray().apply { for (i in sample) put(i) })
            }
            // Merge tool-specific extras (e.g. radius_mm) into the body.
            val keys = extra.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                put(k, extra.get(k))
            }
        }
        val sessionTag = if (session != null) " [session=${session.id}]" else ""
        val text = "$humanLabel$sessionTag — matched $matched tris, painting $painted on ${plan.model.label} " +
            "(${plan.kind.name.lowercase()} tag=${plan.tag}, merge=${plan.merge.name.lowercase()})"
        return ToolResult.ok(text, body)
    }

    /** Read the optional `return_indices` flag from any paint
     *  primitive's args. Default false (since the 2026-05 quiet-by-
     *  default change). LLMs that genuinely consume the indices
     *  (rare — `paint_triangle_list` chaining is the main case) opt
     *  in per call. */
    private fun returnIndicesFlag(args: JSONObject): Boolean =
        args.optBoolean("return_indices", false)

    /** Shared schema fragment for the session_id arg. Added to every
     *  paint primitive: when present, the paint mutates the named
     *  session's scratch buffer instead of the live model (no
     *  WorkspaceAction emit, no scene rebake). See
     *  [PaintSessionTools] / [AiPaintSessionStore]. */
    internal val SESSION_ID_SCHEMA: JSONObject = Schemas.string(
        "Optional headless paint session id (from begin_paint_session). " +
            "When present, this paint mutates the session's scratch buffer instead of the live " +
            "model — no GLB rebake, no scene-entity swap. Commit with commit_paint_session for " +
            "an atomic one-rebake apply, or discard_paint_session to drop.",
    )

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
                "return_indices" to Schemas.bool("If true, response includes triangle_indices array (capped at 4096). Default false to keep responses small — verify with paint_coverage_summary instead."),
                "back_face_filter" to Schemas.bool("Reject triangles whose normal faces the sphere center (default false)"),
                "session_id" to SESSION_ID_SCHEMA,
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
                returnIndices = returnIndicesFlag(args),
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
                "return_indices" to Schemas.bool("If true, response includes triangle_indices array (capped at 4096). Default false to keep responses small — verify with paint_coverage_summary instead."),
                "session_id" to SESSION_ID_SCHEMA,
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
                returnIndices = returnIndicesFlag(args),
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
                "return_indices" to Schemas.bool("If true, response includes triangle_indices array (capped at 4096). Default false to keep responses small — verify with paint_coverage_summary instead."),
                "session_id" to SESSION_ID_SCHEMA,
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
                returnIndices = returnIndicesFlag(args),
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
                "return_indices" to Schemas.bool("If true, response includes triangle_indices array (capped at 4096). Default false to keep responses small — verify with paint_coverage_summary instead."),
                "session_id" to SESSION_ID_SCHEMA,
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
                returnIndices = returnIndicesFlag(args),
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
                "return_indices" to Schemas.bool("If true, response includes triangle_indices array (capped at 4096). Default false to keep responses small — verify with paint_coverage_summary instead."),
                "session_id" to SESSION_ID_SCHEMA,
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
                returnIndices = returnIndicesFlag(args),
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
                "return_indices" to Schemas.bool("If true, response includes triangle_indices array (capped at 4096). Default false to keep responses small — verify with paint_coverage_summary instead."),
                "session_id" to SESSION_ID_SCHEMA,
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
                returnIndices = returnIndicesFlag(args),
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
                "return_indices" to Schemas.bool("If true, response includes triangle_indices array (capped at 4096). Default false to keep responses small — verify with paint_coverage_summary instead."),
                "session_id" to SESSION_ID_SCHEMA,
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
                returnIndices = returnIndicesFlag(args),
            )
        }
    }

    /**
     * The full schema for `inner` is in [PaintWithMirror.inputSchema], but
     * a small on-device LLM can't render the schema back into the right
     * literal under stress. Surface a copy-pasteable example so error
     * recovery is one retry away.
     */
    private const val EXPECTED_INNER_SHAPE: String =
        "Expected `inner` to be an object: " +
            "{\"tool\": \"paint_sphere\" (or paint_slab/paint_normal_cone/paint_geodesic_disc/" +
            "paint_surface_region/paint_connected_component/paint_triangle_list/paint_projected_mask), " +
            "\"arguments\": { ...args for that inner tool, including model_id and tag... }}"

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
                ?: return ToolResult.error(EXPECTED_INNER_SHAPE)
            val innerToolName = inner.optString("tool")
            if (innerToolName.isEmpty())
                return ToolResult.error("inner.tool is required. $EXPECTED_INNER_SHAPE")
            val innerTool = innerTools.firstOrNull { it.name == innerToolName }
                ?: return ToolResult.error(
                    "Unknown inner tool '$innerToolName'. Allowed: " +
                        innerTools.joinToString(", ") { it.name },
                )
            val innerArgs = inner.optJSONObject("arguments")
                ?: return ToolResult.error("inner.arguments object required. $EXPECTED_INNER_SHAPE")
            val modelId = innerArgs.optString("model_id")
            if (modelId.isEmpty())
                return ToolResult.error("inner.arguments.model_id required. $EXPECTED_INNER_SHAPE")
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
                "return_indices" to Schemas.bool("If true, response includes triangle_indices array (capped at 4096). Default false to keep responses small — verify with paint_coverage_summary instead."),
                "session_id" to SESSION_ID_SCHEMA,
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
                returnIndices = returnIndicesFlag(args),
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
