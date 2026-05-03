package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiIntrospection
import dev.orcaxr.app.AiMaskProjection
import dev.orcaxr.app.AiRenderEngine
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

/**
 * D19 sub-items a + d — vision-LLM driven 2D mask authoring. Both
 * tools render a view of the model, send the PNG + a prompt to
 * Claude's Messages API, and parse out polygon outlines that the
 * caller can feed straight into `paint_projected_mask`.
 *
 *  - `generate_mask_from_point` (D19a): "the feature touching pixel
 *    (x, y)". The LLM is shown the render with a small marker at the
 *    requested pixel and asked to outline the SAME feature the
 *    marker sits on. Mirrors the upstream "Segment Anything from a
 *    point" pattern but uses Claude's vision capability so the
 *    on-device dependency is one HTTP call instead of a 60 MB
 *    MobileSAM ONNX bundle.
 *  - `get_mask_for_text` (D19d): "the cheeks of a Pikachu". Free-
 *    form description; the LLM returns one or more polygon outlines
 *    bounding the named features. Mirrors the "CLIPSeg / GroundingDINO
 *    text-to-mask" pattern.
 *
 * Both return a structured payload that includes the camera_descriptor
 * + polygons in pixel coords, so the caller can chain straight into
 * `paint_projected_mask`. Optionally we surface the polygon-projected
 * triangle indices too (saves a round-trip when the caller only wants
 * the tri set, not to inspect the polygons).
 *
 * Cost: ~1¢ per call at claude-haiku-4-5 vision rates. Charged to the
 * user's Anthropic key (configured in McpSettings); the tool returns
 * an error when no key is set.
 */
internal object AiVisionMaskTools {

    /**
     * Shared render setup: builds the camera spec from a view name +
     * model bbox, runs a normal-sphere render, returns the artifact +
     * spec. Same pattern as FindFeatureAnchorsTool.
     */
    internal data class RenderedView(
        val pngBytes: ByteArray,
        val camera: AiRenderEngine.CameraSpec,
        val pngBase64: String,
    )

    internal fun renderViewForVision(
        bvh: dev.orcaxr.app.MeshBvh,
        ws: WorkspaceModel,
        session: AiSessionState,
        viewName: String,
    ): Result<RenderedView> {
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val cam = if (viewName in AiRenderEngine.NAMED_PRESETS) {
            AiRenderEngine.namedPreset(viewName, geom.bboxCenteredPreview, 512, 512)
        } else session.getCameraPreset(viewName.lowercase())?.copy(widthPx = 512, heightPx = 512)
            ?: return Result.failure(IllegalArgumentException("Unknown view_name '$viewName'."))
        val r = AiRenderEngine.render(
            bvh = bvh,
            camera = cam,
            mode = AiRenderEngine.RenderMode.NormalSphere,
            palette = ws.previewPalette.value,
        )
        return Result.success(RenderedView(
            pngBytes = r.pngBytes,
            camera = cam,
            pngBase64 = Base64.getEncoder().encodeToString(r.pngBytes),
        ))
    }

    /**
     * Parse `{polygons: [[x,y,x,y,...], ...]}` out of a Claude
     * Messages response. Tolerates ```json fences and minor prose.
     */
    internal fun parsePolygonsFromResponse(json: JSONObject): JSONArray? {
        val content = json.optJSONArray("content") ?: return null
        for (i in 0 until content.length()) {
            val part = content.optJSONObject(i) ?: continue
            if (part.optString("type") != "text") continue
            val text = part.optString("text").trim()
                .removePrefix("```json").removePrefix("```")
                .removeSuffix("```").trim()
            val obj = runCatching { JSONObject(text) }.getOrNull()
                ?: extractFirstJsonObject(text)
                ?: continue
            return obj.optJSONArray("polygons") ?: continue
        }
        return null
    }

    private fun extractFirstJsonObject(s: String): JSONObject? {
        val start = s.indexOf('{')
        if (start < 0) return null
        var depth = 0
        for (i in start until s.length) {
            when (s[i]) {
                '{' -> depth++
                '}' -> {
                    depth--
                    if (depth == 0) {
                        return runCatching { JSONObject(s.substring(start, i + 1)) }.getOrNull()
                    }
                }
            }
        }
        return null
    }

    /** Encode a CameraSpec for inclusion in a structuredContent body. */
    internal fun encodeCameraDescriptor(cam: AiRenderEngine.CameraSpec): JSONObject = JSONObject().apply {
        put("view_matrix_4x4", JSONArray().apply { for (v in cam.viewMatrixRowMajor) put(v.toDouble()) })
        put("projection_matrix_4x4", JSONArray().apply { for (v in cam.projMatrixRowMajor) put(v.toDouble()) })
        put("width_px", cam.widthPx); put("height_px", cam.heightPx)
    }

    /** Convert a JSONArray of polygons (LLM-returned, possibly with
     *  embedded JSON arrays) into the FloatArray list AiMaskProjection
     *  expects. Returns null if any polygon is malformed. */
    internal fun parsePolygonsToFloat(polysRaw: JSONArray): List<FloatArray>? {
        val out = ArrayList<FloatArray>(polysRaw.length())
        for (i in 0 until polysRaw.length()) {
            val p = polysRaw.optJSONArray(i) ?: return null
            if (p.length() % 2 != 0 || p.length() < 4) return null
            val arr = FloatArray(p.length()) { p.optDouble(it, 0.0).toFloat() }
            out.add(arr)
        }
        return if (out.isEmpty()) null else out
    }

    /**
     * D19a — point-driven 2D segmentation.
     *
     * The LLM-vision call is asked: "the user clicked at pixel
     * (x_px, y_px). Outline the SAME feature the click landed on, as
     * a polygon in pixel coords." The response is parsed back as
     * {polygons:[[...]]}. We then optionally rasterize + project the
     * polygons through `AiMaskProjection.project` to give the caller
     * the hit triangle set immediately.
     */
    class GenerateMaskFromPoint(
        private val ws: WorkspaceModel,
        private val session: AiSessionState,
        private val apiKeyFlow: Flow<String?>,
        private val client: VisionApiClient = OkHttpVisionApiClient(),
    ) : Tool {
        override val name = "generate_mask_from_point"
        override val description =
            "Vision-LLM 2D segmentation: outline the feature touching a single pixel. " +
                "The tool renders a normal-sphere view of the model, asks Claude to outline " +
                "the feature at pixel (x_px, y_px) as a polygon in pixel coords, and returns " +
                "{polygons, camera_descriptor, triangle_indices}. The caller chains the " +
                "polygons + camera_descriptor straight into paint_projected_mask. Mirrors the " +
                "Segment-Anything 'point prompt' pattern using Claude's vision capability so " +
                "no on-device ONNX runtime is required. Costs ~1¢/call at claude-haiku-4-5 " +
                "vision rates; requires an Anthropic API key (set via McpSettings)."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "x_px", "y_px"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "x_px" to Schemas.integer("Pixel x in the rendered view (0..width-1)"),
                "y_px" to Schemas.integer("Pixel y in the rendered view (0..height-1)"),
                "view_name" to Schemas.string("Camera preset (default 'iso')"),
                "hint" to Schemas.string("(optional) free-form English hint about what the click is on"),
                "project_to_triangles" to Schemas.bool(
                    "If true (default), reverse-project the returned polygons onto the mesh and " +
                        "include triangle_indices in the response. If false, only the polygons + " +
                        "camera_descriptor are returned (saves O(W*H*triCount) projection work).",
                ),
                "depth_mode" to Schemas.string("'front_facing_only' (default) | 'any_facing' | 'all_hits'"),
                "model_id_for_vision" to Schemas.string("(advanced) Override Anthropic model id; default 'claude-haiku-4-5'"),
            ),
        )

        override suspend fun call(args: JSONObject): ToolResult {
            if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
            val apiKey = apiKeyFlow.first()
            if (apiKey.isNullOrBlank()) {
                return ToolResult.error(
                    "Anthropic API key not configured. Set via McpSettings.setAnthropicApiKey first.",
                )
            }
            val modelId = args.optString("model_id").trim()
            ws.placedModels.value.firstOrNull { it.id == modelId }
                ?: return ToolResult.error("No model with id '$modelId'.")
            val bvh = ws.getBvh(modelId)
                ?: return ToolResult.error("Couldn't build BVH for '$modelId'.")
            val xPx = args.optInt("x_px", -1)
            val yPx = args.optInt("y_px", -1)
            val viewName = args.optString("view_name", "iso")
            val projectFlag = args.optBoolean("project_to_triangles", true)
            val depthRaw = args.optString("depth_mode", "front_facing_only").lowercase()
            val depth = parseDepthMode(depthRaw)
                ?: return ToolResult.error("depth_mode must be front_facing_only|any_facing|all_hits")
            val visionModel = args.optString("model_id_for_vision").trim()
                .ifEmpty { "claude-haiku-4-5" }
            val hint = args.optString("hint").trim()

            val rendered = renderViewForVision(bvh, ws, session, viewName).getOrElse {
                return ToolResult.error(it.message ?: "render setup failed")
            }
            val cam = rendered.camera
            if (xPx < 0 || xPx >= cam.widthPx || yPx < 0 || yPx >= cam.heightPx) {
                return ToolResult.error(
                    "Pixel ($xPx,$yPx) outside the rendered frame ${cam.widthPx}x${cam.heightPx}.",
                )
            }

            val systemPrompt = """
                You are a 2D segmentation assistant. The user provides a rendered view of a 3D
                model and a single pixel coordinate. Outline the SAME feature the click landed on
                as one or more polygons in pixel coords. Return ONLY a JSON object:
                {"polygons": [[x1, y1, x2, y2, x3, y3, ...], ...]}
                Each polygon is a closed flat list of float pixel coords, top-left origin, where
                (0, 0) is the top-left and (${cam.widthPx - 1}, ${cam.heightPx - 1}) is the
                bottom-right. If the click landed on background or a single small feature, return
                a single polygon with as few vertices as needed (8-32 typical). Do not include
                markdown, explanation, or any other content — JSON only.
            """.trimIndent()

            val userText = buildString {
                append("Outline the feature at pixel (").append(xPx).append(", ").append(yPx).append(").")
                if (hint.isNotEmpty()) {
                    append(" Hint: ").append(hint)
                }
            }
            val request = buildVisionRequest(visionModel, systemPrompt, userText, rendered.pngBase64)
            val response = client.send(apiKey, request)
            if (response.isFailure) {
                return ToolResult.error("Vision API failed: ${response.exceptionOrNull()?.message}")
            }
            val polysRaw = parsePolygonsFromResponse(response.getOrThrow())
                ?: return ToolResult.error(
                    "Couldn't parse polygons from vision response. Raw: " +
                        response.getOrThrow().toString().take(400),
                )
            val polygons = parsePolygonsToFloat(polysRaw)
                ?: return ToolResult.error(
                    "Vision response polygons malformed (each must be ≥ 4 even-length floats).",
                )

            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", modelId)
                put("seed_pixel", JSONObject().apply { put("x", xPx); put("y", yPx) })
                put("view_name", viewName)
                put("polygon_count", polygons.size)
                put("polygons", JSONArray().apply {
                    for (p in polygons) put(JSONArray().apply { for (v in p) put(v.toDouble()) })
                })
                put("camera_descriptor", encodeCameraDescriptor(cam))
            }
            if (projectFlag) {
                val mask = AiMaskProjection.rasterizePolygons(polygons, cam.widthPx, cam.heightPx)
                val tris = AiMaskProjection.project(
                    bvh = bvh, camera = cam, mask = mask,
                    depthMode = depth, backFaceFilter = true,
                )
                body.put("triangle_indices_count", tris.size)
                body.put("mask_on_pixels", mask.count { it })
            }
            val text = "generate_mask_from_point: ${polygons.size} polygon(s) for pixel " +
                "($xPx,$yPx) on $modelId via $viewName"
            return ToolResult.ok(text, body)
        }
    }

    /**
     * D19d — text-to-mask zero-shot 2D segmentation.
     *
     * The LLM is asked: "Outline `<query>` in this rendered view as
     * one or more pixel-space polygons." Same response shape as
     * D19a, same projection chain.
     */
    class GetMaskForText(
        private val ws: WorkspaceModel,
        private val session: AiSessionState,
        private val apiKeyFlow: Flow<String?>,
        private val client: VisionApiClient = OkHttpVisionApiClient(),
    ) : Tool {
        override val name = "get_mask_for_text"
        override val description =
            "Vision-LLM zero-shot text-to-mask. Render a view of the model, ask Claude to " +
                "outline 'the cheeks of a Pikachu' (or any free-form query) as a polygon in " +
                "pixel coords. Returns {polygons, camera_descriptor, triangle_indices}. The " +
                "caller chains polygons + camera_descriptor into paint_projected_mask, OR uses " +
                "triangle_indices directly with paint_triangle_list. Mirrors the CLIPSeg / " +
                "GroundingDINO pattern using Claude's vision capability — no on-device CLIPSeg " +
                "model required. Costs ~1¢/call at claude-haiku-4-5 vision rates."
        override val inputSchema = Schemas.obj(
            required = listOf("model_id", "query"),
            properties = mapOf(
                "model_id" to Schemas.string("Model id"),
                "query" to Schemas.string(
                    "Free-form English description of what to outline, e.g. " +
                        "'the cheeks', 'the smokestack', 'both ears'.",
                ),
                "view_name" to Schemas.string("Camera preset (default 'iso')"),
                "max_polygons" to Schemas.integer("Cap on number of polygons returned (default 4)"),
                "project_to_triangles" to Schemas.bool(
                    "If true (default), reverse-project polygons onto the mesh and include " +
                        "triangle_indices in the response.",
                ),
                "depth_mode" to Schemas.string("'front_facing_only' (default) | 'any_facing' | 'all_hits'"),
                "model_id_for_vision" to Schemas.string("(advanced) Override Anthropic model id; default 'claude-haiku-4-5'"),
            ),
        )

        override suspend fun call(args: JSONObject): ToolResult {
            if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
            val apiKey = apiKeyFlow.first()
            if (apiKey.isNullOrBlank()) {
                return ToolResult.error(
                    "Anthropic API key not configured. Set via McpSettings.setAnthropicApiKey first.",
                )
            }
            val modelId = args.optString("model_id").trim()
            ws.placedModels.value.firstOrNull { it.id == modelId }
                ?: return ToolResult.error("No model with id '$modelId'.")
            val bvh = ws.getBvh(modelId)
                ?: return ToolResult.error("Couldn't build BVH for '$modelId'.")
            val query = args.optString("query").trim()
            if (query.isEmpty()) return ToolResult.error("'query' is required.")
            val viewName = args.optString("view_name", "iso")
            val maxPolygons = args.optInt("max_polygons", 4).coerceIn(1, 16)
            val projectFlag = args.optBoolean("project_to_triangles", true)
            val depthRaw = args.optString("depth_mode", "front_facing_only").lowercase()
            val depth = parseDepthMode(depthRaw)
                ?: return ToolResult.error("depth_mode must be front_facing_only|any_facing|all_hits")
            val visionModel = args.optString("model_id_for_vision").trim()
                .ifEmpty { "claude-haiku-4-5" }

            val rendered = renderViewForVision(bvh, ws, session, viewName).getOrElse {
                return ToolResult.error(it.message ?: "render setup failed")
            }
            val cam = rendered.camera
            val systemPrompt = """
                You are a zero-shot 2D segmentation assistant. The user provides a rendered view
                of a 3D model and a free-form query. Outline the queried feature(s) as one or
                more polygons in pixel coords. Return ONLY a JSON object:
                {"polygons": [[x1, y1, x2, y2, ...], ...]}
                Each polygon is a closed flat list of float pixel coords, top-left origin, where
                (0, 0) is the top-left and (${cam.widthPx - 1}, ${cam.heightPx - 1}) is the
                bottom-right. Return at most $maxPolygons polygons. If the query matches no
                feature in the view (occluded, on the back), return {"polygons": []}. Do not
                include markdown, explanation, or any other content — JSON only.
            """.trimIndent()

            val request = buildVisionRequest(visionModel, systemPrompt, "Outline: $query", rendered.pngBase64)
            val response = client.send(apiKey, request)
            if (response.isFailure) {
                return ToolResult.error("Vision API failed: ${response.exceptionOrNull()?.message}")
            }
            val polysRaw = parsePolygonsFromResponse(response.getOrThrow())
                ?: return ToolResult.error(
                    "Couldn't parse polygons from vision response. Raw: " +
                        response.getOrThrow().toString().take(400),
                )
            // Empty polygon list is a valid result ("query matched
            // nothing visible"); return ok with an empty array
            // instead of erroring.
            val polygons = if (polysRaw.length() == 0) emptyList()
                else parsePolygonsToFloat(polysRaw)
                    ?: return ToolResult.error(
                        "Vision response polygons malformed (each must be ≥ 4 even-length floats).",
                    )

            val body = JSONObject().apply {
                put("ok", true)
                put("model_id", modelId)
                put("query", query)
                put("view_name", viewName)
                put("polygon_count", polygons.size)
                put("polygons", JSONArray().apply {
                    for (p in polygons) put(JSONArray().apply { for (v in p) put(v.toDouble()) })
                })
                put("camera_descriptor", encodeCameraDescriptor(cam))
            }
            if (projectFlag && polygons.isNotEmpty()) {
                val mask = AiMaskProjection.rasterizePolygons(polygons, cam.widthPx, cam.heightPx)
                val tris = AiMaskProjection.project(
                    bvh = bvh, camera = cam, mask = mask,
                    depthMode = depth, backFaceFilter = true,
                )
                body.put("triangle_indices_count", tris.size)
                body.put("mask_on_pixels", mask.count { it })
            } else if (projectFlag) {
                body.put("triangle_indices_count", 0)
                body.put("mask_on_pixels", 0)
            }
            val text = "get_mask_for_text: '${query.take(40)}' → ${polygons.size} polygon(s) on $modelId"
            return ToolResult.ok(text, body)
        }
    }

    private fun parseDepthMode(raw: String): AiMaskProjection.DepthMode? = when (raw) {
        "", "front_facing_only", "front" -> AiMaskProjection.DepthMode.FrontFacingOnly
        "any_facing", "any", "lit" -> AiMaskProjection.DepthMode.AnyFacing
        "all_hits", "all" -> AiMaskProjection.DepthMode.AllHits
        else -> null
    }

    private fun buildVisionRequest(
        visionModelId: String,
        systemPrompt: String,
        userText: String,
        pngB64: String,
    ): JSONObject = JSONObject().apply {
        put("model", visionModelId)
        put("max_tokens", 2048)
        put("system", systemPrompt)
        put("messages", JSONArray().apply {
            put(JSONObject().apply {
                put("role", "user")
                put("content", JSONArray().apply {
                    put(JSONObject().apply {
                        put("type", "image")
                        put("source", JSONObject().apply {
                            put("type", "base64")
                            put("media_type", "image/png")
                            put("data", pngB64)
                        })
                    })
                    put(JSONObject().apply {
                        put("type", "text")
                        put("text", userText)
                    })
                })
            })
        })
    }
}
