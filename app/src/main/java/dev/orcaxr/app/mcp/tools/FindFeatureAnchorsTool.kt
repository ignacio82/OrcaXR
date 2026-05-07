package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiIntrospection
import dev.orcaxr.app.AiMaskProjection
import dev.orcaxr.app.AiRenderEngine
import dev.orcaxr.app.MeshBvh
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolContext
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.flow.first
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * D18c — vision-LLM feature anchor finder. Renders a view of the
 * model, sends the PNG + a hint text to Claude's Messages API, and
 * resolves the returned pixel coords back to triangle ids via
 * AiMaskProjection.pickTriangleAtPixel.
 *
 * Adds an outbound HTTPS dep on api.anthropic.com. Cost: charged
 * to the user's Anthropic key (configured via setAnthropicApiKey
 * in McpSettings). Tool returns isError if no key is set.
 *
 * The response includes both pixel + tri_id per anchor so callers
 * can choose whether to paint via paint_geodesic_disc(anchor=tri_id)
 * or paint_projected_mask(camera_descriptor + polygons around the
 * pixel).
 */
internal class FindFeatureAnchorsTool(
    private val ws: WorkspaceModel,
    private val session: AiSessionState,
    /** Flow that produces the current Anthropic API key. Production
     *  passes `McpSettings.anthropicApiKey`; tests pass a static
     *  `flowOf("fake-key")`. */
    private val apiKeyFlow: kotlinx.coroutines.flow.Flow<String?>,
    private val client: VisionApiClient = OkHttpVisionApiClient(),
) : Tool {
    override val name = "find_feature_anchors"
    override val description =
        "Locate named features (eyes, cheeks, ears, etc.) on a model by sending a rendered view + " +
            "a hint to Claude's vision API. Returns each anchor as {name, x_px, y_px, tri_id, " +
            "confidence}. Pair with paint_geodesic_disc(anchor=tri_id) for surface-bounded paint, " +
            "or paint_projected_mask(camera_descriptor + polygons around the pixel) for shaped " +
            "regions. Requires an Anthropic API key set via the McpSettings.setAnthropicApiKey " +
            "(stored on-device, billed to the user's account). Costs ~1¢ per call at " +
            "claude-haiku-4-5 vision rates."
    override val inputSchema = Schemas.obj(
        required = listOf("model_id", "hint"),
        properties = mapOf(
            "model_id" to Schemas.string("Model id"),
            "hint" to Schemas.string("Free-form English description of features to locate, e.g. 'the eyes and cheeks of a Pikachu'"),
            "view_name" to Schemas.string("Camera preset for the render (default 'iso')"),
            "expected_count" to Schemas.integer("Expected number of anchors (helps the LLM size its response; default 4)"),
            "model_id_for_vision" to Schemas.string("(advanced) Override Anthropic model id; default 'claude-haiku-4-5'"),
        ),
    )

    override suspend fun call(args: JSONObject): ToolResult {
        if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
        val apiKey = apiKeyFlow.first()
        if (apiKey.isNullOrBlank()) {
            return ToolResult.error(
                "Anthropic API key not configured. Set via McpSettings.setAnthropicApiKey first " +
                    "(or skip find_feature_anchors and use render_triangle_id_map + " +
                    "resolve_image_pixel for manual anchor authoring).",
            )
        }
        val modelId = args.optString("model_id").trim()
        val model = ws.placedModels.value.firstOrNull { it.id == modelId }
            ?: return ToolResult.error("No model with id '$modelId'.")
        val bvh = ws.getBvh(modelId)
            ?: return ToolResult.error("Couldn't build BVH for '$modelId'.")
        val hint = args.optString("hint").trim()
        if (hint.isEmpty()) return ToolResult.error("'hint' is required.")
        val viewName = args.optString("view_name", "iso")
        val expectedCount = args.optInt("expected_count", 4).coerceIn(1, 32)
        val visionModel = args.optString("model_id_for_vision").trim().ifEmpty { "claude-haiku-4-5" }

        // Render the requested view.
        val geom = AiIntrospection.geometry(bvh, bins = 1)
        val cam = if (viewName in AiRenderEngine.NAMED_PRESETS) {
            AiRenderEngine.namedPreset(viewName, geom.bboxCenteredPreview, 512, 512)
        } else session.getCameraPreset(viewName.lowercase())?.copy(widthPx = 512, heightPx = 512)
            ?: return ToolResult.error("Unknown view_name '$viewName'.")
        val renderResult = AiRenderEngine.render(
            bvh = bvh,
            camera = cam,
            mode = AiRenderEngine.RenderMode.NormalSphere,  // Best for feature recognition — colors-by-orientation.
            palette = ws.previewPalette.value,
        )
        val png = renderResult.pngBytes
        val pngB64 = Base64.getEncoder().encodeToString(png)

        // Build the system + user prompt.
        val systemPrompt = """
            You are a feature-locator assistant for a 3D model painting tool. The user shows you a
            rendered view of a 3D model and asks you to identify pixel coordinates of named
            features. You MUST return ONLY a JSON object of the form:
            {"anchors": [{"name": "...", "x_px": <int>, "y_px": <int>, "confidence": <0.0-1.0>}, ...]}
            Coordinates are in pixel space, top-left origin, where (0, 0) is the top-left and
            (${cam.widthPx - 1}, ${cam.heightPx - 1}) is the bottom-right of the rendered image.
            Return at most $expectedCount anchors. If you cannot locate a feature, return an empty
            list. Do not include markdown, explanation, or any other content — JSON only.
        """.trimIndent()

        val requestBody = JSONObject().apply {
            put("model", visionModel)
            put("max_tokens", 1024)
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
                            put("text", "Locate: $hint")
                        })
                    })
                })
            })
        }

        val response = client.send(apiKey, requestBody)
        if (response.isFailure) {
            return ToolResult.error("Anthropic API call failed: ${response.exceptionOrNull()?.message}")
        }
        val json = response.getOrNull()
            ?: return ToolResult.error("Anthropic API returned an empty body.")
        val anchorsRaw = parseAnchorsFromResponse(json)
            ?: return ToolResult.error("Couldn't parse anchors from API response. Raw: ${json.toString().take(400)}")

        // Resolve each pixel to a tri_id.
        val results = JSONArray()
        var resolvedCount = 0
        for (i in 0 until anchorsRaw.length()) {
            val a = anchorsRaw.optJSONObject(i) ?: continue
            val xPx = a.optInt("x_px", -1)
            val yPx = a.optInt("y_px", -1)
            val triId = AiMaskProjection.pickTriangleAtPixel(bvh, cam, xPx, yPx)
            results.put(JSONObject().apply {
                put("name", a.optString("name", "anchor_$i"))
                put("x_px", xPx); put("y_px", yPx)
                put("confidence", a.optDouble("confidence", 0.0))
                if (triId != null) {
                    put("tri_id", triId); put("hit", true); resolvedCount++
                } else {
                    put("hit", false)
                }
            })
        }

        val body = JSONObject().apply {
            put("ok", true)
            put("model_id", modelId)
            put("hint", hint)
            put("view_name", viewName)
            put("requested_count", expectedCount)
            put("returned_count", anchorsRaw.length())
            put("resolved_count", resolvedCount)
            put("camera_descriptor", JSONObject().apply {
                put("view_matrix_4x4", JSONArray().apply { for (v in cam.viewMatrixRowMajor) put(v.toDouble()) })
                put("projection_matrix_4x4", JSONArray().apply { for (v in cam.projMatrixRowMajor) put(v.toDouble()) })
                put("width_px", cam.widthPx); put("height_px", cam.heightPx)
            })
            put("anchors", results)
        }
        return ToolResult.ok(
            "Found $resolvedCount of ${anchorsRaw.length()} anchors for '$hint'",
            body,
        )
    }

    /** Pull the `anchors` JSON array out of Claude's response.
     *  The Messages API returns `{content: [{type:'text', text:'...'}, ...]}`. */
    private fun parseAnchorsFromResponse(json: JSONObject): JSONArray? {
        val content = json.optJSONArray("content") ?: return null
        for (i in 0 until content.length()) {
            val part = content.optJSONObject(i) ?: continue
            if (part.optString("type") != "text") continue
            val text = part.optString("text").trim()
            // Strip optional ```json fences.
            val stripped = text.removePrefix("```json").removePrefix("```")
                .removeSuffix("```").trim()
            // The text should be a JSON object containing
            // `anchors`. Some models may add extra prose; do a
            // substring scan for the first JSON-looking object.
            val obj = runCatching { JSONObject(stripped) }
                .getOrNull()
                ?: extractFirstJsonObject(stripped)
                ?: continue
            return obj.optJSONArray("anchors") ?: continue
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
}

/** Injectable HTTP client so tests can fake the Anthropic API. */
internal interface VisionApiClient {
    suspend fun send(apiKey: String, requestBody: JSONObject): Result<JSONObject>
}

internal class OkHttpVisionApiClient : VisionApiClient {
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    override suspend fun send(apiKey: String, requestBody: JSONObject): Result<JSONObject> {
        // Audit H25 — bound vision-API throughput across all four
        // tools so a runaway LLM client can't burn the user's
        // Anthropic quota. The leaky bucket allows ~2 req/s sustained
        // with a 4-call burst head; cooperative cancellation flows
        // through `delay` if the caller's coroutine is cancelled.
        dev.orcaxr.app.mcp.VisionRateLimiter.shared.acquire()
        return runCatching {
            val request = Request.Builder()
                .url("https://api.anthropic.com/v1/messages")
                .addHeader("x-api-key", apiKey)
                .addHeader("anthropic-version", "2023-06-01")
                .addHeader("content-type", "application/json")
                .post(requestBody.toString().toRequestBody("application/json".toMediaType()))
                .build()
            http.newCall(request).execute().use { resp ->
                val body = resp.body?.string() ?: throw IllegalStateException("empty body")
                if (!resp.isSuccessful) {
                    throw IllegalStateException("HTTP ${resp.code}: ${body.take(400)}")
                }
                JSONObject(body)
            }
        }
    }
}
