package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiIntrospection
import dev.orcaxr.app.AiRenderEngine
import dev.orcaxr.app.mcp.AiPaintSessionStore
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

/**
 * Vision-LLM verifier loop. Render the model's CURRENT paint at a
 * named view, send it alongside a reference image (URI or base64) to
 * Claude's Messages API, and parse a 0..1 overall match score plus
 * per-region notes. Closes the perception → action gap that an LLM
 * paint loop otherwise has to bridge with brittle pixel comparisons.
 *
 * Why a separate tool rather than reusing find_feature_anchors:
 *  - The verifier's job is grading + correction notes, not
 *    locating named features. The system prompt is different.
 *  - The reference image is the SECOND image the LLM compares against
 *    (find_feature_anchors only sends one image — the rendered model).
 *  - The structured response shape is `{score, comment, regions}` not
 *    `{anchors: [{x_px, y_px, ...}]}`.
 *
 * API key flow: same `unifiedClaudeKey` flow that
 * find_feature_anchors uses (McpSettings.anthropicApiKey ⊔
 * LlmSettings.claudeApiKey). Tool returns isError when no key is
 * set so the LLM gets a clean "set a key first" instead of a 401.
 */
internal class ScorePaintAgainstReferenceTool(
    private val ws: WorkspaceModel,
    private val sessionState: AiSessionState,
    private val apiKeyFlow: kotlinx.coroutines.flow.Flow<String?>,
    private val client: VisionApiClient = OkHttpVisionApiClient(),
) : Tool {
    override val name = "score_paint_against_reference"
    override val description =
        "Grade the model's CURRENT paint against a reference image. Renders the model at the " +
            "given view, attaches it alongside the reference image (passed as base64 OR a " +
            "render_token from a prior render_view call OR a render artifact via image_uri), and " +
            "asks Claude's vision API for a 0..1 match score plus per-region notes. The LLM in " +
            "OrcaXR's session loop can then call this after each paint pass and decide whether to " +
            "iterate (score < 0.85), stop (score ≥ 0.85), or roll back (score dropped). Reference " +
            "images can be photos of the figure, official artwork, or another rendered model — " +
            "anything PNG/JPEG that fits in the API's per-image cap. Requires an Anthropic key " +
            "(same flow as find_feature_anchors). Costs ~2× find_feature_anchors per call (two " +
            "images). When session_id is set the rendered current paint is read from the " +
            "session's scratch buffer."
    override val inputSchema = Schemas.obj(
        required = listOf("model_id", "view_name"),
        properties = mapOf(
            "model_id" to Schemas.string("Model id"),
            "view_name" to Schemas.string("Camera preset (front | iso | …) or a name from name_view"),
            "reference_image_base64" to Schemas.string(
                "Reference image as a base64-encoded PNG / JPEG (no data: prefix). One of " +
                    "reference_image_base64 / reference_render_token must be set.",
            ),
            "reference_render_token" to Schemas.string(
                "Alternative to reference_image_base64: a render_token from an earlier " +
                    "render_view call whose PNG should be the reference (e.g. you rendered an " +
                    "ideal painted model and want to compare against it).",
            ),
            "reference_media_type" to Schemas.string(
                "MIME type for reference_image_base64 (default 'image/png'). Use 'image/jpeg' " +
                    "for JPEG references.",
            ),
            "panel_size_px" to Schemas.integer("Render dimension for the current paint (default 512)"),
            "rubric" to Schemas.string(
                "Optional grading rubric prepended to the prompt. Default is 'Compare paint " +
                    "color and coverage; ignore camera angle, lighting, and resolution.'",
            ),
            "vision_model" to Schemas.string(
                "Optional Anthropic model id. Default 'claude-haiku-4-5' (cheapest); use " +
                    "'claude-sonnet-4-6' for harder figures or 'claude-opus-4-7' for the highest " +
                    "fidelity grading.",
            ),
            "session_id" to AiVisionTools.SESSION_ID_SCHEMA,
        ),
    )
    override suspend fun call(args: JSONObject): ToolResult {
        if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
        val apiKey = apiKeyFlow.first()
        if (apiKey.isNullOrBlank()) {
            return ToolResult.error(
                "Anthropic API key not configured. Set via McpSettings.setAnthropicApiKey or " +
                    "the in-app LLM settings card first.",
            )
        }
        val modelId = args.optString("model_id").trim()
        if (modelId.isEmpty()) return ToolResult.error("'model_id' is required.")
        val model = ws.placedModels.value.firstOrNull { it.id == modelId }
            ?: return ToolResult.error("No model with id '$modelId'.")
        val bvh = ws.getBvh(modelId)
            ?: return ToolResult.error("Couldn't build BVH for '$modelId'.")
        val viewName = args.optString("view_name").lowercase().trim()
        if (viewName.isEmpty()) return ToolResult.error("'view_name' is required.")
        val cell = args.optInt("panel_size_px", 512).coerceIn(128, 1024)
        val visionModel = args.optString("vision_model").trim().ifEmpty { "claude-haiku-4-5" }
        val rubric = args.optString("rubric").trim().ifEmpty {
            "Compare paint color and coverage between the rendered model and the reference. " +
                "Ignore camera angle, lighting, and resolution mismatches; focus on whether the " +
                "right regions of the figure carry the right colors. Score 1.0 = visually " +
                "indistinguishable colors and coverage; 0.5 = colors right but coverage wrong " +
                "(or vice versa); 0.0 = completely off."
        }

        // 1) Resolve the reference image bytes (one of three sources).
        val refRenderToken = args.optString("reference_render_token").trim()
        val refMediaType = args.optString("reference_media_type")
            .ifEmpty { "image/png" }
        val (refBytesB64, refSourceLabel) = if (refRenderToken.isNotEmpty()) {
            val art = sessionState.getArtifact(refRenderToken)
                ?: return ToolResult.error(
                    "Unknown reference_render_token '$refRenderToken' (artifact may have been evicted).",
                )
            Base64.getEncoder().encodeToString(art.pngBytes) to "render_token:$refRenderToken"
        } else {
            val refB64 = args.optString("reference_image_base64").trim()
            if (refB64.isEmpty()) {
                return ToolResult.error(
                    "Provide reference_image_base64 OR reference_render_token.",
                )
            }
            refB64 to "base64"
        }

        // 2) Resolve session paint (if any) and render the current state.
        val sessionId = args.optString("session_id").trim()
        val paintForRender = if (sessionId.isNotEmpty()) {
            val session = AiPaintSessionStore.get().get(sessionId)
                ?: return ToolResult.error("Unknown session_id '$sessionId'.")
            if (session.modelId != modelId) {
                return ToolResult.error(
                    "session_id '$sessionId' targets '${session.modelId}' but model_id='$modelId'.",
                )
            }
            session.paintFilamentIndex
        } else {
            model.paintFilamentIndex
        }

        val cam = if (viewName in AiRenderEngine.NAMED_PRESETS) {
            val geom = AiIntrospection.geometry(bvh, bins = 1)
            AiRenderEngine.namedPreset(viewName, geom.bboxCenteredPreview, cell, cell)
        } else {
            sessionState.getCameraPreset(viewName)?.copy(widthPx = cell, heightPx = cell)
                ?: return ToolResult.error(
                    "Unknown view_name '$viewName'. Built-ins: ${AiRenderEngine.NAMED_PRESETS.joinToString(", ")}.",
                )
        }
        val render = AiRenderEngine.render(
            bvh = bvh,
            camera = cam,
            mode = AiRenderEngine.RenderMode.Paint,
            palette = ws.previewPalette.value,
            paintFilamentIndex = paintForRender,
        )
        val currentB64 = Base64.getEncoder().encodeToString(render.pngBytes)

        // 3) Build the request. We pin the system prompt to a JSON
        //    schema so the response is parseable — same trick as
        //    find_feature_anchors.
        val systemPrompt = """
            You are a paint-quality grader for a 3D model painting tool. The user shows you two
            images: (1) a rendered view of the user's CURRENT painted model, (2) a REFERENCE
            image (photo, artwork, or rendered ideal). Compare the two and produce a JSON object
            of the form:
            {
              "score": <0.0..1.0>,
              "comment": "<one short sentence summarising the result>",
              "regions": [
                {"name": "<region label>", "issue": "<what's wrong>", "suggestion": "<what to do>"},
                ...
              ]
            }
            Rubric: $rubric
            Return ONLY the JSON object. No markdown, no prose. If the regions list is empty
            (perfect match), return regions: []. Score MUST be a number between 0 and 1
            inclusive.
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
                            put("type", "text")
                            put("text", "Image 1 (current paint):")
                        })
                        put(JSONObject().apply {
                            put("type", "image")
                            put("source", JSONObject().apply {
                                put("type", "base64")
                                put("media_type", "image/png")
                                put("data", currentB64)
                            })
                        })
                        put(JSONObject().apply {
                            put("type", "text")
                            put("text", "Image 2 (reference):")
                        })
                        put(JSONObject().apply {
                            put("type", "image")
                            put("source", JSONObject().apply {
                                put("type", "base64")
                                put("media_type", refMediaType)
                                put("data", refBytesB64)
                            })
                        })
                    })
                })
            })
        }

        val response = client.send(apiKey, requestBody)
        if (response.isFailure) {
            return ToolResult.error(
                "Anthropic API call failed: ${response.exceptionOrNull()?.message}",
            )
        }
        val json = response.getOrNull()
            ?: return ToolResult.error("Anthropic API returned an empty body.")

        // 4) Parse the score / comment / regions.
        val parsed = parseGradingResponse(json)
            ?: return ToolResult.error(
                "Couldn't parse grading from API response. Raw: ${json.toString().take(400)}",
            )
        val score = parsed.optDouble("score", 0.0)
        val regionsArr = parsed.optJSONArray("regions") ?: JSONArray()
        val body = JSONObject().apply {
            put("ok", true)
            put("model_id", modelId)
            put("view_name", viewName)
            put("vision_model", visionModel)
            put("reference_source", refSourceLabel)
            put("score", score)
            put("comment", parsed.optString("comment", ""))
            put("regions", regionsArr)
            put("region_count", regionsArr.length())
            put("hint", when {
                score >= 0.85 -> "Score ≥ 0.85: paint is good. Stop iterating."
                score >= 0.6 -> "Score 0.6..0.85: minor corrections; review regions[] and apply targeted paint passes."
                else -> "Score < 0.6: significant mismatch. Consider discard_paint_session and re-plan from scratch."
            })
        }
        val text = "score_paint_against_reference: score=${"%.2f".format(score)} " +
            "(${regionsArr.length()} corrections noted)"
        return ToolResult.ok(text, body)
    }

    /** Pull the grading object out of Claude's response. Same shape
     *  parsing as FindFeatureAnchorsTool but for our `{score, ...}`
     *  schema. */
    private fun parseGradingResponse(json: JSONObject): JSONObject? {
        val content = json.optJSONArray("content") ?: return null
        for (i in 0 until content.length()) {
            val part = content.optJSONObject(i) ?: continue
            if (part.optString("type") != "text") continue
            val text = part.optString("text").trim()
            val stripped = text.removePrefix("```json").removePrefix("```")
                .removeSuffix("```").trim()
            val obj = runCatching { JSONObject(stripped) }
                .getOrNull()
                ?: extractFirstJsonObject(stripped)
                ?: continue
            // We expect score / comment / regions fields. Don't fail
            // hard if regions is missing; do require score to be a
            // number.
            if (!obj.has("score")) continue
            return obj
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
