package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiRenderEngine
import dev.orcaxr.app.AutoPaintImageEngine
import dev.orcaxr.app.MAX_PAINT_SLOTS
import dev.orcaxr.app.SemanticPaintPlanner
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.TierBCapability
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

/**
 * Smart Auto-Paint (D20, M4) — `auto_paint_from_reference`.
 *
 * The headline "make it look like this" path. Given a reference image
 * (a photo / artwork / render of the subject — NOT necessarily aligned
 * to the mesh), the tool:
 *
 *  1. renders the model from `view` (NormalSphere — orientation cues
 *     help the model reason about geometry),
 *  2. asks the vision model for a paint plan: a whole-model
 *     `base_color` plus accent `regions`, each with a target color and
 *     polygons in the rendered view's pixel space,
 *  3. resolves the plan to a full-coverage per-triangle slot assignment
 *     ([SemanticPaintPlanner] — base fills everything incl. the unseen
 *     back; region polygons reverse-project to triangles exactly like
 *     `get_mask_for_text`),
 *  4. renders the candidate and grades it against the reference (the
 *     same two-image {score,comment,regions[]} contract as
 *     `score_paint_against_reference`),
 *  5. iterates up to `max_iterations`, feeding the grader's critique
 *     back into the next plan, keeping the highest-scoring candidate
 *     (monotonic — a worse refinement never wins),
 *  6. commits the best candidate as ONE `LoadPaintState` (one undo).
 *
 * `dry_run=true` runs the loop and returns the plan/score report
 * without committing. Physical-only by default; `use_full_spectrum=true`
 * is experimental (also matches FS blends, materializing virtual rows
 * for the active printer). Needs an Anthropic key (LlmSettings /
 * McpSettings).
 */
internal class AutoPaintReferenceTool(
    private val ws: WorkspaceModel,
    private val session: AiSessionState,
    private val apiKeyFlow: Flow<String?>,
    private val client: VisionApiClient = OkHttpVisionApiClient(),
    private val fsStore: FsPaintSupport.MixedRowStore? = null,
) : Tool {
    override val name = "auto_paint_from_reference"
    override val description =
        "Paint the whole model to resemble a reference image (photo / artwork / render) " +
            "using the vision model + an automated grade-and-refine loop, in one undo " +
            "step. Renders the model from `view`, asks for a paint plan (base color + " +
            "accent regions with polygons), reverse-projects regions to triangles, grades " +
            "the result against the reference, and iterates up to max_iterations keeping " +
            "the best-scoring attempt. Reference is reference_image_base64 OR " +
            "reference_render_token. dry_run=true returns the plan/score report without " +
            "applying. Physical-only by default; use_full_spectrum (experimental) also matches FS blends. model_id optional when " +
            "exactly one model is placed. Requires an Anthropic API key."
    override val inputSchema = Schemas.obj(
        properties = mapOf(
            "model_id" to Schemas.string("Model id. Optional if exactly one model is placed."),
            "reference_image_base64" to Schemas.string("Base64 reference image."),
            "reference_render_token" to Schemas.string("Render-artifact token to use as the reference."),
            "reference_media_type" to Schemas.string("Reference MIME (default image/png)."),
            "view" to Schemas.string(
                "Render view for planning: a named preset (iso, front, …) or a saved " +
                    "camera name. Default 'iso'.",
            ),
            "max_iterations" to Schemas.integer("Grade/refine passes, 1..5 (default 2)."),
            "score_threshold" to Schemas.number("Stop when the grader score ≥ this (default 0.85)."),
            "max_colors" to Schemas.integer("Cap on palette slots (1..$MAX_PAINT_SLOTS)."),
            "vision_model" to Schemas.string("Anthropic model id (default claude-haiku-4-5)."),
            "dry_run" to Schemas.bool("Run the loop but do NOT apply (default false)."),
            "use_full_spectrum" to Schemas.bool("Experimental: also match FullSpectrum blend colors (materializes virtual rows)."),
        ),
    )

    override suspend fun call(args: JSONObject): ToolResult {
        if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
        val useFs = args.optBoolean("use_full_spectrum", false)
        val apiKey = apiKeyFlow.first()
        if (apiKey.isNullOrBlank()) {
            return ToolResult.error(
                "Anthropic API key not configured. Set it in the LLM / MCP settings, or " +
                    "use the no-API auto_paint (geometric / image-projection) instead.",
            )
        }

        val models = ws.placedModels.value
        val requestedId = args.optString("model_id").trim()
        val model = when {
            requestedId.isNotEmpty() ->
                models.firstOrNull { it.id == requestedId }
                    ?: return ToolResult.error("No model with id '$requestedId'.")
            models.size == 1 -> models[0]
            models.isEmpty() -> return ToolResult.error("No models placed.")
            else -> return ToolResult.error(
                "model_id is required when more than one model is placed (${models.size} present).",
            )
        }
        val bvh = ws.getBvh(model.id)
            ?: return ToolResult.error("Couldn't build BVH for '${model.id}'.")
        if (bvh.triCount == 0) return ToolResult.error("Model '${model.id}' has no triangles.")

        val paletteSize = ws.previewPalette.value.count { it.isNotBlank() }
        if (paletteSize == 0) {
            return ToolResult.error("No palette — set the workspace filament colors first.")
        }
        val maxColors = if (args.has("max_colors")) {
            args.optInt("max_colors", paletteSize).coerceIn(1, MAX_PAINT_SLOTS)
        } else {
            paletteSize
        }
        val fsPal = FsPaintSupport.resolvePalette(
            useFs, ws.previewPalette.value.filter { it.isNotBlank() }.take(maxColors),
            fsStore, ws.selectedPrinterId.value,
        )
        val palette = fsPal.paletteSlots
        if (palette.isEmpty()) return ToolResult.error("No usable filament colors in the palette.")

        // Reference image.
        val refMediaType = args.optString("reference_media_type").ifEmpty { "image/png" }
        val refToken = args.optString("reference_render_token").trim()
        val refB64: String = if (refToken.isNotEmpty()) {
            val art = session.getArtifact(refToken)
                ?: return ToolResult.error("Unknown reference_render_token '$refToken'.")
            Base64.getEncoder().encodeToString(art.pngBytes)
        } else {
            args.optString("reference_image_base64").trim().ifEmpty {
                return ToolResult.error("Provide reference_image_base64 OR reference_render_token.")
            }
        }

        // Planning camera.
        val viewName = args.optString("view").trim().ifEmpty { "iso" }
        val camera = if (viewName in AiRenderEngine.NAMED_PRESETS) {
            AiRenderEngine.namedPreset(viewName, AutoPaintImageEngine.bboxOf(bvh), 512, 512)
        } else {
            session.getCameraPreset(viewName.lowercase())?.copy(widthPx = 512, heightPx = 512)
                ?: return ToolResult.error(
                    "Unknown view '$viewName' (use a named preset or a saved camera).",
                )
        }
        val modelViewB64 = Base64.getEncoder().encodeToString(
            AiRenderEngine.render(
                bvh, camera, AiRenderEngine.RenderMode.NormalSphere,
                palette = ws.previewPalette.value,
            ).pngBytes,
        )

        val maxIter = args.optInt("max_iterations", 2).coerceIn(1, 5)
        val threshold = args.optDouble("score_threshold", 0.85).coerceIn(0.0, 1.0)
        val visionModel = args.optString("vision_model").ifEmpty { "claude-haiku-4-5" }

        var best: ByteArray? = null
        var bestScore = -1.0
        var bestComment = ""
        var bestPlanRegions: List<SemanticPaintPlanner.RegionStat> = emptyList()
        var bestBaseSlot = 0
        val iterReport = JSONArray()
        var feedback: JSONArray? = null

        for (iter in 1..maxIter) {
            val planReq = buildPlanRequest(
                visionModel, viewName, camera.widthPx, camera.heightPx,
                refMediaType, refB64, modelViewB64, feedback,
            )
            val planResp = client.send(apiKey, planReq)
            val planJson = planResp.getOrNull()?.let { extractJson(it, "base_color") }
            if (planJson == null) {
                if (best != null) break
                return ToolResult.error(
                    "Vision model returned no usable paint plan" +
                        (planResp.exceptionOrNull()?.let { ": ${it.message}" } ?: "."),
                )
            }
            val resolved = SemanticPaintPlanner.resolve(bvh, camera, planJson, palette)
                ?: run {
                    if (best != null) break
                    return ToolResult.error(
                        "Paint plan had no usable base_color for the active palette.",
                    )
                }
            val candidate = resolved.perTriangleSlot

            // Grade the candidate against the reference.
            val candB64 = Base64.getEncoder().encodeToString(
                AiRenderEngine.render(
                    bvh, camera, AiRenderEngine.RenderMode.Paint,
                    palette = ws.previewPalette.value, paintFilamentIndex = candidate,
                ).pngBytes,
            )
            val gradeReq = buildGradeRequest(visionModel, candB64, refMediaType, refB64)
            val gradeJson = client.send(apiKey, gradeReq).getOrNull()?.let { extractJson(it, "score") }
            val score = gradeJson?.optDouble("score", Double.NaN)?.takeIf { !it.isNaN() }
            val comment = gradeJson?.optString("comment") ?: ""

            iterReport.put(JSONObject().apply {
                put("iteration", iter)
                put("score", score ?: JSONObject.NULL)
                put("comment", comment)
            })

            // Track the best (monotonic — a regression never wins). If
            // grading failed, take the candidate only if we have none.
            val effScore = score ?: if (best == null) 0.0 else Double.NEGATIVE_INFINITY
            if (effScore > bestScore) {
                best = candidate
                bestScore = effScore
                bestComment = comment
                bestPlanRegions = resolved.regions
                bestBaseSlot = resolved.baseSlot
            }
            if (score == null) break // can't iterate without a score
            if (score >= threshold) break
            feedback = gradeJson.optJSONArray("regions")
        }

        val basePaint = best ?: return ToolResult.error("No usable paint produced.")
        var finalPaint = basePaint
        var fsReport: Any? = fsPal.note
        val builtFs = fsPal.built
        if (builtFs != null && fsStore != null) {
            val fin = FsPaintSupport.finalize(
                builtFs, basePaint, fsStore, ws.selectedPrinterId.value!!,
            )
            finalPaint = fin.paint
            fsReport = fin.report
        }
        val dryRun = args.optBoolean("dry_run", false)

        val hist = IntArray(MAX_PAINT_SLOTS + 1)
        for (s in finalPaint) hist[s.toInt() and 0xff]++
        val histArr = JSONArray()
        var slotsUsed = 0
        for (slot in 1..MAX_PAINT_SLOTS) if (hist[slot] > 0) {
            slotsUsed++
            histArr.put(JSONObject().apply { put("slot", slot); put("triangles", hist[slot]) })
        }
        val regionsArr = JSONArray()
        for (r in bestPlanRegions) regionsArr.put(JSONObject().apply {
            put("name", r.name); put("slot", r.slot); put("triangles", r.triangleCount)
        })
        val body = JSONObject().apply {
            put("ok", true)
            put("model_id", model.id)
            put("view", viewName)
            put("triangles", bvh.triCount)
            put("base_slot", bestBaseSlot)
            put("final_score", if (bestScore >= 0) bestScore else JSONObject.NULL)
            put("final_comment", bestComment)
            put("iterations", iterReport)
            put("regions", regionsArr)
            put("slots_used", slotsUsed)
            put("per_slot_histogram", histArr)
            if (fsReport != null) put("full_spectrum", fsReport)
            put("dry_run", dryRun)
            put("applied", false)
        }

        if (dryRun) {
            return ToolResult.ok(
                "auto_paint_from_reference dry-run: best score ${fmt(bestScore)} over " +
                    "${iterReport.length()} iteration(s), $slotsUsed slots (not applied)",
                body,
            )
        }
        if (!ws.isCapabilityWired(TierBCapability.LoadPaintState)) {
            return ToolResult.error(
                "LoadPaintState capability isn't wired in the active OrcaXR shell, so the " +
                    "paint would be silently dropped. Bring the activity into Slicer / " +
                    "Prepare (XR) or MobileShell (phone) and retry, or use dry_run=true.",
            )
        }
        ws.emit(
            WorkspaceAction.LoadPaintState(
                modelId = model.id,
                paintFilamentIndex = finalPaint,
                supportFlags = model.supportFlags,
                seamFlags = model.seamFlags,
                fuzzySkinFlags = model.fuzzySkinFlags,
            ),
        )
        body.put("applied", true)
        return ToolResult.ok(
            "auto_paint_from_reference: best score ${fmt(bestScore)} over " +
                "${iterReport.length()} iteration(s) → $slotsUsed slots, ${bvh.triCount} " +
                "triangles (one undo step).",
            body,
        )
    }

    private fun fmt(s: Double): String =
        if (s < 0) "n/a" else String.format("%.2f", s)

    private fun imagePart(mediaType: String, b64: String): JSONObject = JSONObject().apply {
        put("type", "image")
        put("source", JSONObject().apply {
            put("type", "base64"); put("media_type", mediaType); put("data", b64)
        })
    }

    private fun textPart(text: String): JSONObject =
        JSONObject().apply { put("type", "text"); put("text", text) }

    private fun buildPlanRequest(
        visionModel: String,
        viewName: String,
        w: Int,
        h: Int,
        refMediaType: String,
        refB64: String,
        modelB64: String,
        feedback: JSONArray?,
    ): JSONObject {
        val system = """
            You are a 3D-print colorist. The user shows you a REFERENCE image and a
            rendered VIEW of an unpainted 3D model (normals shaded). Produce a paint
            plan that makes the model resemble the reference. Return ONLY this JSON:
            {"base_color":"#RRGGBB",
             "regions":[{"name":"<label>","color":"#RRGGBB",
                         "polygons":[[x1,y1,x2,y2,...], ...]}]}
            base_color is the whole-model base (also covers faces not visible in the
            view). Each region is an accent: its polygons are closed flat lists of
            float pixel coords in the VIEW image's space, top-left origin, (0,0) to
            (${w - 1},${h - 1}). Use few regions (the salient color areas only). If the
            model should be a single color, return "regions":[]. No markdown, JSON only.
        """.trimIndent()
        val content = JSONArray().apply {
            put(textPart("REFERENCE image (paint the model to look like this):"))
            put(imagePart(refMediaType, refB64))
            put(textPart("MODEL view '$viewName' (${w}x${h}px). Give region polygons in THIS image's pixel coords."))
            put(imagePart("image/png", modelB64))
            if (feedback != null && feedback.length() > 0) {
                put(textPart("Previous attempt feedback to fix: $feedback"))
            }
        }
        return JSONObject().apply {
            put("model", visionModel)
            put("max_tokens", 2048)
            put("system", system)
            put("messages", JSONArray().apply {
                put(JSONObject().apply { put("role", "user"); put("content", content) })
            })
        }
    }

    private fun buildGradeRequest(
        visionModel: String,
        currentB64: String,
        refMediaType: String,
        refB64: String,
    ): JSONObject {
        val system = """
            You are a paint-quality grader. Image 1 is the user's CURRENT painted model,
            Image 2 is the REFERENCE. Compare them and return ONLY this JSON:
            {"score":<0.0..1.0>,"comment":"<one sentence>",
             "regions":[{"name":"<label>","issue":"<wrong>","suggestion":"<fix>"}]}
            Rubric: judge color choice and coverage match; ignore camera angle,
            lighting, and resolution. regions:[] when it's a good match. Score MUST be
            a number in [0,1]. No markdown, JSON only.
        """.trimIndent()
        val content = JSONArray().apply {
            put(textPart("Image 1 (current paint):"))
            put(imagePart("image/png", currentB64))
            put(textPart("Image 2 (reference):"))
            put(imagePart(refMediaType, refB64))
        }
        return JSONObject().apply {
            put("model", visionModel)
            put("max_tokens", 1024)
            put("system", system)
            put("messages", JSONArray().apply {
                put(JSONObject().apply { put("role", "user"); put("content", content) })
            })
        }
    }

    /** Pull the first text content part, strip ``` fences, parse JSON,
     *  require [requiredKey]. Mirrors the other vision tools' parser. */
    private fun extractJson(json: JSONObject, requiredKey: String): JSONObject? {
        val content = json.optJSONArray("content") ?: return null
        for (i in 0 until content.length()) {
            val part = content.optJSONObject(i) ?: continue
            if (part.optString("type") != "text") continue
            val text = part.optString("text").trim()
            val stripped = text.removePrefix("```json").removePrefix("```")
                .removeSuffix("```").trim()
            val obj = runCatching { JSONObject(stripped) }.getOrNull()
                ?: extractFirstBraceObject(stripped)
                ?: continue
            if (obj.has(requiredKey)) return obj
        }
        return null
    }

    private fun extractFirstBraceObject(s: String): JSONObject? {
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
