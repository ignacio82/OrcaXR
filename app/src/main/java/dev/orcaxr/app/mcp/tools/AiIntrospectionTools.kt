package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiIntrospection
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject

/**
 * AI-driven paint pillar (C9 milestone 3) — geometry / topology
 * introspection MCP tools. Pure Kotlin; runs against the same
 * BvhProvider M1 already wired.
 *
 * Tools:
 *  - get_model_geometry: total triangles, bbox in centered_preview
 *    frame, bbox in printer_frame (PlacedModel transforms applied),
 *    surface area, volume, watertight check, per-Z histogram.
 *  - get_model_components: connected components partition.
 *  - get_model_face_orientation_summary: 6 cardinal direction
 *    buckets at 30° half-angle + diagonal residual.
 *  - get_model_semantic_regions: region-growing clusters with
 *    heuristic labels ("vertical_side_large", etc.).
 *
 * The LLM uses these to map the model BEFORE painting it. See the
 * "Worked example: Benchy semantic regions" section in
 * docs/AI_PAINT_DESIGN.md for the canonical pirate-ship workflow.
 */
internal object AiIntrospectionTools {

    fun all(ws: WorkspaceModel): List<Tool> = listOf(
        GetModelGeometry(ws),
        GetModelComponents(ws),
        GetModelFaceOrientationSummary(ws),
        GetModelSemanticRegions(ws),
        GetCurvatureSegmentation(ws),
    )

    private suspend fun resolveModelAndBvh(
        ws: WorkspaceModel,
        args: JSONObject,
    ): Pair<PlacedModel, MeshBvh>? {
        val id = args.optString("model_id").trim()
        if (id.isEmpty()) return null
        val model = ws.placedModels.value.firstOrNull { it.id == id } ?: return null
        val bvh = ws.getBvh(id) ?: return null
        return model to bvh
    }

    private fun encodeBbox(b: AiIntrospection.Bbox): JSONObject = JSONObject().apply {
        put("x_min", b.minX.toDouble()); put("y_min", b.minY.toDouble()); put("z_min", b.minZ.toDouble())
        put("x_max", b.maxX.toDouble()); put("y_max", b.maxY.toDouble()); put("z_max", b.maxZ.toDouble())
        put("size_x_mm", b.sizeX.toDouble()); put("size_y_mm", b.sizeY.toDouble()); put("size_z_mm", b.sizeZ.toDouble())
    }

    private fun encodeVec3(v: FloatArray): JSONObject = JSONObject().apply {
        put("x", v[0].toDouble()); put("y", v[1].toDouble()); put("z", v[2].toDouble())
    }

    private fun encodeIndices(arr: IntArray, sampleSize: Int = 32): JSONArray {
        val cap = sampleSize.coerceAtMost(arr.size)
        val out = JSONArray()
        // Uniform sample across the array so the LLM gets a
        // representative spread (not just the first 32).
        if (arr.isEmpty()) return out
        if (arr.size <= sampleSize) {
            for (v in arr) out.put(v)
        } else {
            for (i in 0 until cap) {
                val idx = (i.toDouble() * (arr.size - 1) / (cap - 1).coerceAtLeast(1)).toInt()
                out.put(arr[idx])
            }
        }
        return out
    }

    class GetModelGeometry(private val ws: WorkspaceModel) : Tool {
        override val name = "get_model_geometry"
        override val description =
            "Geometry summary for a placed model: total_triangle_count, bbox in centered_preview_mm " +
                "(the frame all spatial paint primitives use), surface_area_mm2, volume_mm3, watertight " +
                "(open_edge_count == 0), and a 32-bin per-Z histogram of triangle area. Use this to " +
                "sanity-check coordinates BEFORE issuing paint primitives — the bbox tells you the " +
                "valid range of sphere centers / slab planes / cone directions."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf("model_id" to Schemas.string("Model id from list_placed_models")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val (model, bvh) = resolveModelAndBvh(ws, args)
                ?: return ToolResult.error("Couldn't resolve model + BVH (model not loaded?).")
            val summary = AiIntrospection.geometry(bvh)
            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", model.id)
                put("label", model.label)
                put("total_triangle_count", summary.totalTriangleCount)
                put("bbox_centered_preview", encodeBbox(summary.bboxCenteredPreview))
                put("centroid_centered_preview", encodeVec3(summary.centroidCenteredPreview))
                put("surface_area_mm2", summary.surfaceAreaMm2.toDouble())
                put("volume_mm3", summary.volumeMm3.toDouble())
                put("open_edge_count", summary.openEdgeCount)
                put("watertight", summary.openEdgeCount == 0)
                val hist = JSONArray()
                for (b in summary.zHistogram) {
                    hist.put(JSONObject().apply {
                        put("z_min_mm", b.zMin.toDouble())
                        put("z_max_mm", b.zMax.toDouble())
                        put("area_mm2", b.areaMm2.toDouble())
                        put("triangle_count", b.triangleCount)
                    })
                }
                put("z_histogram", hist)
            }
            val text = "Geometry of ${model.label}: ${summary.totalTriangleCount} triangles, " +
                "size ${summary.bboxCenteredPreview.sizeX}×${summary.bboxCenteredPreview.sizeY}×" +
                "${summary.bboxCenteredPreview.sizeZ} mm, area ${summary.surfaceAreaMm2} mm², " +
                "volume ${summary.volumeMm3} mm³"
            return ToolResult.ok(text, body)
        }
    }

    class GetModelComponents(private val ws: WorkspaceModel) : Tool {
        override val name = "get_model_components"
        override val description =
            "Partition the model into connected components (vertex-adjacency BFS). Returns one entry " +
                "per component, sorted by descending triangle count. Use when a model is actually " +
                "multiple disjoint meshes (e.g. some Benchy STLs have the smokestack separate) — pair " +
                "with paint_connected_component to paint just the chosen one."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf("model_id" to Schemas.string("Model id")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val (model, bvh) = resolveModelAndBvh(ws, args)
                ?: return ToolResult.error("Couldn't resolve model + BVH.")
            val components = AiIntrospection.components(bvh)
            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", model.id)
                put("component_count", components.size)
                val arr = JSONArray()
                for (c in components) {
                    arr.put(JSONObject().apply {
                        put("component_id", c.componentId)
                        put("triangle_count", c.triangleIndices.size)
                        put("triangle_indices_sample", encodeIndices(c.triangleIndices))
                        put("bbox_centered_preview", encodeBbox(c.bbox))
                        put("centroid", encodeVec3(c.centroid))
                        put("surface_area_mm2", c.surfaceAreaMm2.toDouble())
                        put("volume_mm3", c.volumeMm3.toDouble())
                    })
                }
                put("components", arr)
            }
            return ToolResult.ok(
                "${components.size} component(s) on ${model.label}",
                body,
            )
        }
    }

    class GetModelFaceOrientationSummary(private val ws: WorkspaceModel) : Tool {
        override val name = "get_model_face_orientation_summary"
        override val description =
            "Bucket triangles by outward normal: 'up' (+Z), 'down' (-Z), 'front' (-Y), 'back' (+Y), " +
                "'left' (-X), 'right' (+X), each at a 30° half-angle cone, plus 'diagonal' for the " +
                "residual. Useful for quick orientation reasoning ('paint everything horizontal-down' " +
                "= use paint_normal_cone with the 'down' bucket's parameters)."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf("model_id" to Schemas.string("Model id")),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val (model, bvh) = resolveModelAndBvh(ws, args)
                ?: return ToolResult.error("Couldn't resolve model + BVH.")
            val buckets = AiIntrospection.faceOrientationSummary(bvh)
            var totalArea = 0.0
            for (b in buckets) totalArea += b.areaMm2
            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", model.id)
                val arr = JSONArray()
                for (b in buckets) {
                    arr.put(JSONObject().apply {
                        put("name", b.name)
                        put("normal", JSONObject().apply {
                            put("x", b.normalX.toDouble())
                            put("y", b.normalY.toDouble())
                            put("z", b.normalZ.toDouble())
                        })
                        put("cone_half_angle_deg", b.coneHalfAngleDeg.toDouble())
                        put("triangle_count", b.triangleCount)
                        put("area_mm2", b.areaMm2.toDouble())
                    })
                }
                put("buckets", arr)
                put("total_area_mm2", totalArea)
            }
            return ToolResult.ok(
                "Face orientation summary for ${model.label}",
                body,
            )
        }
    }

    class GetModelSemanticRegions(private val ws: WorkspaceModel) : Tool {
        override val name = "get_model_semantic_regions"
        override val description =
            "Region-growing semantic segmentation: clusters triangles whose normals stay within a " +
                "tolerance and whose centroids stay within a fraction of the bbox diagonal. Each " +
                "region gets a heuristic label like 'vertical_side_large' or 'horizontal_top_medium' " +
                "and a sample of its triangle indices (use paint_triangle_list with sample, or " +
                "paint_surface_region with seed=region.triangle_indices_sample[0] to fill the whole " +
                "region with smart-fill). The MOST USEFUL tool for the canonical 'paint Benchy as a " +
                "pirate ship' workflow — call this first, look at the region list, then issue paint " +
                "calls per region. Returns at most max_regions entries (default 12), sorted by area " +
                "descending; tiny clusters (< min_region_area_pct%) are dropped."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "max_regions" to Schemas.integer("Max regions to return (default 12)"),
                "min_region_area_pct" to Schemas.number("Min region area as % of total surface area (default 1.5)"),
                "normal_tolerance_deg" to Schemas.number("Normal alignment tolerance during region growth (default 35°)"),
                "distance_cap_fraction" to Schemas.number("Hard distance cap as fraction of bbox diagonal (default 0.3)"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val (model, bvh) = resolveModelAndBvh(ws, args)
                ?: return ToolResult.error("Couldn't resolve model + BVH.")
            val maxRegions = args.optInt("max_regions", 12).coerceIn(1, 64)
            val minAreaPct = (optFloat(args, "min_region_area_pct") ?: 1.5f).coerceIn(0f, 100f)
            val normalTol = (optFloat(args, "normal_tolerance_deg") ?: 35f).coerceIn(1f, 90f)
            val distFrac = (optFloat(args, "distance_cap_fraction") ?: 0.3f).coerceIn(0.01f, 5f)
            val regions = AiIntrospection.semanticRegions(
                bvh,
                maxRegions = maxRegions,
                normalToleranceDeg = normalTol,
                distanceCapFraction = distFrac,
                minRegionAreaPct = minAreaPct,
            )
            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", model.id)
                put("region_count", regions.size)
                val arr = JSONArray()
                for (r in regions) {
                    arr.put(JSONObject().apply {
                        put("region_id", r.regionId)
                        put("label", r.label)
                        put("triangle_count", r.triangleIndices.size)
                        put("triangle_indices_sample", encodeIndices(r.triangleIndices))
                        put("bbox_centered_preview", encodeBbox(r.bbox))
                        put("centroid", encodeVec3(r.centroid))
                        put("mean_normal", encodeVec3(r.meanNormal))
                        put("area_mm2", r.areaMm2.toDouble())
                    })
                }
                put("regions", arr)
            }
            val text = "${regions.size} semantic region(s) on ${model.label}: " +
                regions.joinToString(", ") { "${it.regionId}:${it.label}(${it.triangleIndices.size})" }
            return ToolResult.ok(text, body)
        }
    }

    /**
     * D19b — multi-scale curvature segmentation. Uses dihedral-angle
     * curvature aggregated across two scales to find feature
     * boundaries, then region-grows from low-curvature seeds. The
     * complementary tool to `get_model_semantic_regions`: where the
     * legacy normal-based heuristic over-fragments organic models
     * (Pikachu, Stanford Bunny, anything continuously curved), this
     * one groups whole feature surfaces (an entire cheek bulge, the
     * whole top of the bunny head) until a curvature ridge is
     * crossed.
     */
    class GetCurvatureSegmentation(private val ws: WorkspaceModel) : Tool {
        override val name = "get_curvature_segmentation"
        override val description =
            "Multi-scale curvature segmentation: per-triangle dihedral-angle score is computed " +
                "at two scales (direct neighbors + 1-ring neighborhood) and combined; smooth " +
                "interiors become seed regions, sharp creases become boundaries. Better than " +
                "get_model_semantic_regions for organic / continuously-curved models because it " +
                "doesn't depend on cardinal-axis alignment of the normals — it finds whole " +
                "smooth feature surfaces (a cheek bulge, the back of an ear) bounded by their " +
                "curvature ridges. Each segment gets a label like 'smooth_horizontal_top' / " +
                "'creased_diagonal' / 'gentle_vertical_side' combining curvature level + " +
                "orientation. Use this BEFORE painting an organic model — call it once, look " +
                "at the segment list, then issue paint_geodesic_disc(seed=segment.tri_sample[0]) " +
                "or paint_triangle_list per segment."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "max_segments" to Schemas.integer("Max segments to return (default 24)"),
                "crease_threshold_deg" to Schemas.number(
                    "Curvature score above which a triangle is treated as a feature boundary " +
                        "(default 22°). Higher = larger smooth segments swallow more curvature; " +
                        "lower = more aggressive splitting along subtle ridges.",
                ),
                "seed_dihedral_cap_deg" to Schemas.number(
                    "Max angle between seed normal and a candidate neighbor normal during " +
                        "growth (default 35°). Caps how far a single segment can wrap around " +
                        "a bulge before splitting.",
                ),
                "min_segment_tri_count" to Schemas.integer("Drop segments smaller than this (default 8)"),
            ),
        )
        override suspend fun call(args: JSONObject): ToolResult {
            val (model, bvh) = resolveModelAndBvh(ws, args)
                ?: return ToolResult.error("Couldn't resolve model + BVH.")
            val maxSegments = args.optInt("max_segments", 24).coerceIn(1, 128)
            val crease = (optFloat(args, "crease_threshold_deg") ?: 22f).coerceIn(0f, 180f)
            val seedCap = (optFloat(args, "seed_dihedral_cap_deg") ?: 35f).coerceIn(0f, 180f)
            val minTri = args.optInt("min_segment_tri_count", 8).coerceAtLeast(1)
            val segments = AiIntrospection.curvatureSegmentation(
                bvh,
                creaseThresholdDeg = crease,
                seedDihedralCapDeg = seedCap,
                maxSegments = maxSegments,
                minSegmentTriCount = minTri,
            )
            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", model.id)
                put("segment_count", segments.size)
                val arr = JSONArray()
                for (s in segments) {
                    arr.put(JSONObject().apply {
                        put("segment_id", s.segmentId)
                        put("label", s.label)
                        put("triangle_count", s.triangleIndices.size)
                        put("triangle_indices_sample", encodeIndices(s.triangleIndices))
                        put("bbox_centered_preview", encodeBbox(s.bbox))
                        put("centroid", encodeVec3(s.centroid))
                        put("mean_normal", encodeVec3(s.meanNormal))
                        put("area_mm2", s.areaMm2.toDouble())
                        put("mean_curvature_deg", s.meanCurvatureScore.toDouble())
                    })
                }
                put("segments", arr)
                put("crease_threshold_deg", crease.toDouble())
                put("seed_dihedral_cap_deg", seedCap.toDouble())
            }
            val text = "${segments.size} curvature segment(s) on ${model.label}: " +
                segments.joinToString(", ") {
                    "${it.segmentId}:${it.label}(${it.triangleIndices.size})"
                }
            return ToolResult.ok(text, body)
        }
    }

    private fun optFloat(args: JSONObject, key: String): Float? {
        if (!args.has(key)) return null
        val v = args.opt(key)
        return when (v) {
            is Number -> v.toFloat()
            is String -> v.toFloatOrNull()
            else -> null
        }
    }
}
