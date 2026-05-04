package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiIntrospection
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject

/**
 * Paint by SEGMENTATION REGION rather than triangle list. The LLM
 * calls one of the existing introspection tools (`get_model_semantic_regions`,
 * `get_curvature_segmentation`, `get_model_components`,
 * `find_recessed_features`), looks at the region list, then says
 * "paint region 3 yellow" instead of "paint triangles [123, 456, ...] yellow".
 *
 * Two reasons this matters:
 *
 * 1. **Token efficiency.** A semantic region on a 1.4M-triangle dragon
 *    can hold 50K+ tris; expanding it into a `paint_triangle_list` arg
 *    blows past the 65K cap and the JSON-RPC body cap. By keeping the
 *    expansion server-side we never serialize the index list.
 * 2. **Semantic stability.** The LLM thinks in parts ("the ears", "the
 *    cheek bulge") not triangle ids. A region/segment id survives
 *    across renders inside one analysis call; a triangle id can shift
 *    when the LLM re-fetches a different segmentation.
 *
 * The cache lives on [AiSessionState] so a region id resolved here
 * always points at the SAME tri set the introspection call returned.
 * Calling `get_curvature_segmentation` overwrites the curvature cache
 * for that model — region ids reset. The cache is per-app-run.
 */
internal object AiSemanticPaintTools {

    private val SUPPORTED_SOURCES =
        setOf("semantic", "curvature", "components", "recess", "recessed")

    fun all(ws: WorkspaceModel, paintTools: List<Tool>): List<Tool> = listOf(
        PrimeRegionCache(ws),
        PaintSemanticRegion(ws, paintTools),
    )

    /**
     * Compute (or recompute) a segmentation and store it in the
     * [AiSessionState] cache so [PaintSemanticRegion] can resolve a
     * region id without the LLM having to also call the introspection
     * tool. Returns the same shape the matching introspection tool
     * returns so an LLM that already knows that tool can drop in.
     *
     * In practice an LLM that just called
     * `get_model_semantic_regions` doesn't NEED to call this — the
     * introspection tools register their results in the same cache
     * automatically (we wire this up via [registerSegmentationFromIntrospection]).
     * `prime_region_cache` is the explicit, opt-in entry point.
     */
    class PrimeRegionCache(private val ws: WorkspaceModel) : Tool {
        override val name = "prime_region_cache"
        override val description =
            "Run a segmentation and store the result in the AI session's region cache so " +
                "paint_semantic_region can paint by region_id without you having to also pass the " +
                "triangle list. `source` picks the segmentation algorithm: 'semantic' (normal-based " +
                "region growing — fast, cardinal-axis-friendly), 'curvature' (multi-scale dihedral " +
                "— better on organic / continuously-curved meshes), 'components' (connected sub-" +
                "meshes, no angle gate), or 'recess' / 'recessed' (signed-curvature inward features " +
                "— eyes / mouths / fingerprints). Each call REPLACES the cache entry for (model_id, " +
                "source). Tip: call get_model_semantic_regions / get_curvature_segmentation / " +
                "get_model_components / find_recessed_features instead — those publish into the " +
                "same cache automatically as a side effect, so you usually don't need this tool."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "source"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "source" to Schemas.string(
                    "'semantic' | 'curvature' | 'components' | 'recess' / 'recessed'",
                ),
                "max_regions" to Schemas.integer("Cap on regions returned (default 24)"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
            val modelId = args.optString("model_id").trim()
            if (modelId.isEmpty()) return ToolResult.error("'model_id' is required.")
            val bvh = ws.getBvh(modelId)
                ?: return ToolResult.error("Couldn't build BVH for '$modelId'.")
            val sourceRaw = args.optString("source").lowercase().trim()
            if (sourceRaw !in SUPPORTED_SOURCES) {
                return ToolResult.error(
                    "Unknown source '$sourceRaw'. Use one of: ${SUPPORTED_SOURCES.sorted().joinToString(", ")}.",
                )
            }
            val source = if (sourceRaw == "recessed") "recess" else sourceRaw
            val maxRegions = args.optInt("max_regions", 24).coerceIn(1, 128)
            val entry = computeAndCache(bvh, modelId, source, maxRegions)
            val arr = JSONArray()
            for (r in entry.regions) {
                arr.put(JSONObject().apply {
                    put("region_id", r.regionId)
                    put("label", r.label)
                    put("triangle_count", r.triangleIndices.size)
                    put("seed_triangle_id", r.seedTriangleId)
                    put("area_mm2", r.areaMm2.toDouble())
                    put("centroid", JSONObject().apply {
                        put("x", r.centroid[0].toDouble())
                        put("y", r.centroid[1].toDouble())
                        put("z", r.centroid[2].toDouble())
                    })
                })
            }
            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", modelId)
                put("source", source)
                put("region_count", entry.regions.size)
                put("regions", arr)
                put("cached_at_ms", entry.createdAtMs)
                put("hint", "Pass region_id to paint_semantic_region to paint each region.")
            }
            return ToolResult.ok(
                "${entry.regions.size} ${source} region(s) cached for $modelId",
                body,
            )
        }
    }

    class PaintSemanticRegion(
        private val ws: WorkspaceModel,
        private val paintTools: List<Tool>,
    ) : Tool {
        override val name = "paint_semantic_region"
        override val description =
            "Paint every triangle inside one of the cached segmentation regions. Workflow: call " +
                "get_model_semantic_regions / get_curvature_segmentation / get_model_components / " +
                "find_recessed_features (or prime_region_cache) FIRST so the segmentation is in " +
                "the AI session's cache, then call this tool with the region_id you want. The " +
                "tool dispatches paint_triangle_list under the hood, so all the usual paint args " +
                "apply (kind, merge, where_tag, session_id). Cache lifetime is the app run; if " +
                "OrcaXR was restarted between the introspection call and this one, recompute via " +
                "prime_region_cache or the matching introspection tool. NOTE: a region's triangle " +
                "set is materialised at cache-write time — re-running the introspection tool " +
                "with different parameters writes a NEW cache entry; old region_ids are not " +
                "revalidated. Pass `painted_count` from this response to verify coverage."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "region_source", "region_id", "tag"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "region_source" to Schemas.string(
                    "Which cached segmentation: 'semantic' | 'curvature' | 'components' | " +
                        "'recess' / 'recessed'",
                ),
                "region_id" to Schemas.integer("region_id from the matching introspection result"),
                "kind" to Schemas.string("'color' (default) | 'support' | 'seam' | 'fuzzy_skin'"),
                "tag" to Schemas.integer("Tag to apply (filament slot 1..32, support 0..2, etc.)"),
                "merge" to Schemas.string("'replace' (default) | 'only_unpainted' | 'only_tagged'"),
                "where_tag" to Schemas.integer("Required when merge='only_tagged'"),
                "session_id" to AiPaintTools.SESSION_ID_SCHEMA,
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
            val modelId = args.optString("model_id").trim()
            if (modelId.isEmpty()) return ToolResult.error("'model_id' is required.")
            val sourceRaw = args.optString("region_source").lowercase().trim()
            if (sourceRaw !in SUPPORTED_SOURCES) {
                return ToolResult.error(
                    "'region_source' must be one of: ${SUPPORTED_SOURCES.sorted().joinToString(", ")}.",
                )
            }
            val source = if (sourceRaw == "recessed") "recess" else sourceRaw
            if (!args.has("region_id")) return ToolResult.error("'region_id' is required.")
            val regionId = args.optInt("region_id", -1)
            if (regionId < 0) return ToolResult.error("region_id must be ≥ 0.")
            val cached = AiSessionState.get().getSegmentation(modelId, source)
                ?: return autoComputeIfPossible(modelId, source, regionId, args)
            val region = cached.regions.firstOrNull { it.regionId == regionId }
                ?: return ToolResult.error(
                    "No region $regionId in cached '$source' segmentation (${cached.regions.size} " +
                        "regions; valid ids 0..${cached.regions.lastIndex}). Recompute via " +
                        "prime_region_cache or the matching introspection tool.",
                )
            val triList = paintTools.firstOrNull { it.name == "paint_triangle_list" }
                ?: return ToolResult.error("paint_triangle_list not registered.")
            val forwarded = JSONObject().apply {
                put("model_id", modelId)
                if (args.has("kind")) put("kind", args.opt("kind"))
                if (args.has("tag")) put("tag", args.opt("tag"))
                if (args.has("merge")) put("merge", args.opt("merge"))
                if (args.has("where_tag")) put("where_tag", args.opt("where_tag"))
                if (args.has("session_id")) put("session_id", args.optString("session_id"))
                val ids = JSONArray().apply {
                    for (t in region.triangleIndices) put(t)
                }
                put("triangle_ids", ids)
            }
            val r = triList.call(forwarded)
            val structured = r.structured ?: JSONObject()
            structured.put("region_source", source)
            structured.put("region_id", regionId)
            structured.put("region_label", region.label)
            structured.put("region_triangle_count", region.triangleIndices.size)
            structured.put("region_area_mm2", region.areaMm2.toDouble())
            structured.put("region_seed_triangle_id", region.seedTriangleId)
            val text = if (r.isError) {
                "paint_semantic_region $source/$regionId (${region.label}): ${r.text}"
            } else {
                "paint_semantic_region $source/$regionId (${region.label}, " +
                    "${region.triangleIndices.size} tris): ${r.text}"
            }
            return ToolResult(text, structured, isError = r.isError)
        }

        /** When the cache is empty we lazily run the matching analysis
         *  with default parameters so the LLM doesn't have to chain two
         *  calls just to paint the largest region. The price is a one-
         *  time analysis cost; the result is cached for subsequent
         *  paint_semantic_region calls. */
        private suspend fun autoComputeIfPossible(
            modelId: String,
            source: String,
            regionId: Int,
            args: JSONObject,
        ): ToolResult {
            val bvh = ws.getBvh(modelId)
                ?: return ToolResult.error("Couldn't build BVH for '$modelId'.")
            val entry = computeAndCache(bvh, modelId, source, maxRegions = 24)
            if (entry.regions.isEmpty()) {
                return ToolResult.error(
                    "Auto-computed '$source' segmentation produced no regions. " +
                        "Try a different source or check the model has loaded.",
                )
            }
            return call(args)  // recurse — the cache is now populated
        }
    }

    /**
     * Compute a segmentation, write it to the cache, and return the
     * fresh entry. Public so the introspection tools can publish their
     * results too (single source of truth for the cache shape).
     */
    internal fun computeAndCache(
        bvh: MeshBvh,
        modelId: String,
        source: String,
        maxRegions: Int,
    ): AiSessionState.SegmentationCacheEntry {
        val regions = when (source) {
            "semantic" -> AiIntrospection.semanticRegions(bvh, maxRegions = maxRegions)
                .map { r ->
                    AiSessionState.RegionEntry(
                        regionId = r.regionId,
                        label = r.label,
                        triangleIndices = r.triangleIndices,
                        seedTriangleId = r.triangleIndices.firstOrNull() ?: -1,
                        areaMm2 = r.areaMm2,
                        centroid = r.centroid,
                    )
                }
            "curvature" -> AiIntrospection.curvatureSegmentation(bvh, maxSegments = maxRegions)
                .map { s ->
                    AiSessionState.RegionEntry(
                        regionId = s.segmentId,
                        label = s.label,
                        triangleIndices = s.triangleIndices,
                        seedTriangleId = s.triangleIndices.firstOrNull() ?: -1,
                        areaMm2 = s.areaMm2,
                        centroid = s.centroid,
                    )
                }
            "components" -> AiIntrospection.components(bvh)
                .take(maxRegions)
                .map { c ->
                    AiSessionState.RegionEntry(
                        regionId = c.componentId,
                        label = "component_${c.componentId}",
                        triangleIndices = c.triangleIndices,
                        seedTriangleId = c.triangleIndices.firstOrNull() ?: -1,
                        areaMm2 = c.surfaceAreaMm2,
                        centroid = c.centroid,
                    )
                }
            "recess" -> AiIntrospection.findRecessedFeatures(bvh, maxFeatures = maxRegions)
                .map { f ->
                    AiSessionState.RegionEntry(
                        regionId = f.featureId,
                        label = f.label,
                        triangleIndices = f.triangleIndices,
                        seedTriangleId = f.seedTriangleId,
                        areaMm2 = f.areaMm2,
                        centroid = f.centroid,
                    )
                }
            else -> emptyList()
        }
        val entry = AiSessionState.SegmentationCacheEntry(
            source = source,
            regions = regions,
            createdAtMs = System.currentTimeMillis(),
            params = "max_regions=$maxRegions",
        )
        AiSessionState.get().saveSegmentation(modelId, entry)
        return entry
    }
}
