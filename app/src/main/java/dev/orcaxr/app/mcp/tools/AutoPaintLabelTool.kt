package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiRenderEngine
import dev.orcaxr.app.AutoPaintCascade
import dev.orcaxr.app.AutoPaintEngine
import dev.orcaxr.app.AutoPaintImageEngine
import dev.orcaxr.app.ColorScience
import dev.orcaxr.app.MAX_PAINT_SLOTS
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
 * Smart Auto-Paint — `auto_paint_label` (borrowed idea #2 from
 * `u1-slicer-for-android`: keep the LLM OUT of spatial grounding).
 *
 * Their hard-won lesson (their fix32 pivot): vision models are
 * unreliable at returning correct polygons/regions but reliable at
 * *naming what they see*. So instead of asking the model to segment
 * (our M4 path, which is right when there's a reference image), this
 * tool segments **deterministically** ([AutoPaintCascade]) and asks the
 * model only to NAME each region and suggest a realistic filament
 * colour — a pure text task over two images (plain shaded + the same
 * model with the regions banded in distinct colours, same camera).
 *
 * AI is decorative and optional (their principle): if no provider /
 * key is available or the reply doesn't parse, the deterministic
 * cascade colours are committed anyway (`ai_used=false`). One undo
 * step. Physical-only (FS deferred). Uses the multi-provider client
 * (borrowed idea #3) so it works on the free tiers, not Anthropic-only.
 */
internal class AutoPaintLabelTool(
    private val ws: WorkspaceModel,
    private val session: AiSessionState,
    private val apiKeyFlow: Flow<String?>,
    private val clientFor: (VisionProvider) -> VisionApiClient = { MultiProviderVisionClient(it) },
) : Tool {
    override val name = "auto_paint_label"
    override val description =
        "Auto-paint with deterministic segmentation + an AI naming/recolour pass (no " +
            "spatial grounding — robust). Segments the model via the metadata-aware " +
            "cascade (existing paint → shells → geometry), renders a plain + a " +
            "region-banded view, and asks the vision model only to NAME each region and " +
            "suggest a realistic filament colour; colours are quantized (CIEDE2000) to " +
            "the active palette. AI is optional: with no provider/key, or on a parse " +
            "failure, the deterministic cascade colours are applied anyway " +
            "(ai_used=false). provider: claude|gemini|openai|openrouter|pollinations " +
            "(default claude). api_key optional (else the configured Anthropic key). " +
            "dry_run previews. One undo step; support/seam/fuzzy preserved. " +
            "use_full_spectrum rejected (FS deferred)."
    override val inputSchema = Schemas.obj(
        properties = mapOf(
            "model_id" to Schemas.string("Model id. Optional if exactly one model is placed."),
            "strategy" to Schemas.string("Cascade axis hint only via `axis`; segmentation is the cascade."),
            "axis" to Schemas.string("Height-band axis if the cascade falls back to geometry: x|y|z (default z)."),
            "max_colors" to Schemas.integer("Cap on palette slots (1..$MAX_PAINT_SLOTS)."),
            "provider" to Schemas.string("claude|gemini|openai|openrouter|pollinations (default claude)."),
            "api_key" to Schemas.string("Override key for the chosen provider (else the Anthropic key)."),
            "vision_model" to Schemas.string("Provider model id (else the provider default)."),
            "dry_run" to Schemas.bool("Compute + return without applying (default false)."),
            "use_full_spectrum" to Schemas.bool("Reserved — rejected (FS deferred)."),
        ),
    )

    override suspend fun call(args: JSONObject): ToolResult {
        if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
        if (args.optBoolean("use_full_spectrum", false)) {
            return ToolResult.error(
                "use_full_spectrum is not available yet (FS deferred until PeggyPalette is " +
                    "green — docs/proposals/smart-auto-paint.md). Re-run physical-only.",
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
        if (paletteSize == 0) return ToolResult.error("No palette — set filament colors first.")
        val maxColors = if (args.has("max_colors")) {
            args.optInt("max_colors", paletteSize).coerceIn(1, MAX_PAINT_SLOTS)
        } else {
            paletteSize
        }
        val k = minOf(paletteSize, maxColors).coerceIn(1, MAX_PAINT_SLOTS)
        val palette = AutoPaintImageEngine.paletteFromHex(
            ws.previewPalette.value.filter { it.isNotBlank() }.take(maxColors),
        )
        if (palette.isEmpty()) return ToolResult.error("No usable filament colors.")

        val axisKey = args.optString("axis").trim().ifEmpty { "z" }
        val axis = AutoPaintEngine.Axis.fromKey(axisKey)
            ?: return ToolResult.error("Unknown axis '$axisKey'. Use x | y | z.")

        // Deterministic segmentation (idea #1 cascade).
        val seg = AutoPaintCascade.run(bvh, model.paintFilamentIndex, k, axis)
        val bandSlots = seg.perTriangleSlot
        val distinctBands = (1..MAX_PAINT_SLOTS).filter { slot ->
            bandSlots.any { (it.toInt() and 0xff) == slot }
        }
        val bandCount = distinctBands.size

        // Default mapping: identity (band slot already a palette slot).
        var finalPaint = bandSlots
        var aiUsed = false
        var aiFailed = false
        val bandInfo = JSONArray()
        var providerUsed = "none"

        val provider = VisionProvider.fromId(args.optString("provider").ifEmpty { "claude" })
        val apiKey = args.optString("api_key").trim().ifEmpty { apiKeyFlow.first() ?: "" }
        val canAi = bandCount >= 1 && (!provider.requiresKey || apiKey.isNotBlank())

        if (canAi) {
            providerUsed = provider.name.lowercase()
            val bbox = AutoPaintImageEngine.bboxOf(bvh)
            val cam = AiRenderEngine.namedPreset("iso", bbox, 512, 512)
            val shaded = Base64.getEncoder().encodeToString(
                AiRenderEngine.render(
                    bvh, cam, AiRenderEngine.RenderMode.Solid, palette = ws.previewPalette.value,
                ).pngBytes,
            )
            val banded = Base64.getEncoder().encodeToString(
                AiRenderEngine.render(
                    bvh, cam, AiRenderEngine.RenderMode.Paint,
                    palette = BAND_VIS_PALETTE, paintFilamentIndex = bandSlots,
                ).pngBytes,
            )
            val req = buildLabelRequest(
                args.optString("vision_model").ifEmpty { "" }, bandCount, shaded, banded,
            )
            val resp = runCatching { clientFor(provider).send(apiKey, req) }.getOrNull()
            val segments = resp?.getOrNull()?.let { parseSegments(it) }
            if (segments != null) {
                aiUsed = true
                val remap = IntArray(MAX_PAINT_SLOTS + 1) { it } // identity default
                for (i in distinctBands.indices) {
                    val band = distinctBands[i]
                    val sg = segments.getOrNull(i) // missing → keep identity
                    val lab = sg?.colour?.let { ColorScience.parseLab(it) }
                    val slot = if (lab != null) nearestSlot(lab, palette) else band
                    remap[band] = slot
                    bandInfo.put(JSONObject().apply {
                        put("id", i); put("band_slot", band)
                        put("label", sg?.label ?: "Region ${i + 1}")
                        put("suggested_colour", sg?.colour ?: JSONObject.NULL)
                        put("slot", slot)
                    })
                }
                finalPaint = ByteArray(bandSlots.size) { t ->
                    remap[bandSlots[t].toInt() and 0xff].toByte()
                }
            } else {
                aiFailed = true
            }
        }

        if (!AutoPaintEngine.isFullCoverage(finalPaint)) {
            return ToolResult.error("Internal: segmentation left triangles unpainted.")
        }

        val hist = IntArray(MAX_PAINT_SLOTS + 1)
        for (s in finalPaint) hist[s.toInt() and 0xff]++
        val histArr = JSONArray()
        var slotsUsed = 0
        for (slot in 1..MAX_PAINT_SLOTS) if (hist[slot] > 0) {
            slotsUsed++
            histArr.put(JSONObject().apply { put("slot", slot); put("triangles", hist[slot]) })
        }
        val dryRun = args.optBoolean("dry_run", false)
        val body = JSONObject().apply {
            put("ok", true)
            put("model_id", model.id)
            put("triangles", bvh.triCount)
            put("source", seg.source.key)
            put("band_count", bandCount)
            put("ai_used", aiUsed)
            put("ai_failed", aiFailed)
            put("provider", if (aiUsed) providerUsed else "none")
            put("bands", bandInfo)
            put("slots_used", slotsUsed)
            put("per_slot_histogram", histArr)
            put("dry_run", dryRun)
            put("applied", false)
        }
        if (dryRun) {
            return ToolResult.ok(
                "auto_paint_label dry-run: ${seg.source.key} → $bandCount bands, " +
                    "ai_used=$aiUsed (not applied)",
                body,
            )
        }
        if (!ws.isCapabilityWired(TierBCapability.LoadPaintState)) {
            return ToolResult.error(
                "LoadPaintState capability isn't wired in the active OrcaXR shell. Bring " +
                    "the activity into Slicer / Prepare (XR) or MobileShell (phone), or " +
                    "use dry_run=true.",
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
            "auto_paint_label: ${seg.source.key} → $bandCount bands, " +
                (if (aiUsed) "AI-named ($providerUsed)" else "deterministic colours") +
                ", $slotsUsed slots (one undo step).",
            body,
        )
    }

    private data class Seg(val label: String, val colour: String)

    private fun nearestSlot(
        lab: ColorScience.Lab,
        palette: List<AutoPaintImageEngine.PaletteSlot>,
    ): Int {
        var best = palette[0].slot
        var bestD = Double.POSITIVE_INFINITY
        for (p in palette) {
            val d = ColorScience.ciede2000(lab, p.lab)
            if (d < bestD) { bestD = d; best = p.slot }
        }
        return best
    }

    private fun buildLabelRequest(
        visionModel: String,
        bandCount: Int,
        shadedB64: String,
        bandedB64: String,
    ): JSONObject {
        val system =
            "You are looking at two views of the SAME 3D model from the same camera angle:\n" +
                "  • Image 1: plain shaded render — identify what the object IS.\n" +
                "  • Image 2: the same model with $bandCount painted regions in distinct " +
                "colours. Region ids are 0..${bandCount - 1}.\n\n" +
                "Name the part of the object each region covers (real anatomical/structural " +
                "names, not \"Region 1\"), and suggest a realistic filament colour per " +
                "region so the print looks natural. Return exactly $bandCount entries in " +
                "region-id order. Respond ONLY with JSON:\n" +
                "{\"segments\":[{\"id\":0,\"label\":\"...\",\"colour\":\"#RRGGBB\"}, ...]}"
        val content = JSONArray().apply {
            put(JSONObject().put("type", "text").put("text", "Name and colour each region."))
            put(JSONObject().put("type", "image").put(
                "source",
                JSONObject().put("type", "base64").put("media_type", "image/png").put("data", shadedB64),
            ))
            put(JSONObject().put("type", "image").put(
                "source",
                JSONObject().put("type", "base64").put("media_type", "image/png").put("data", bandedB64),
            ))
        }
        return JSONObject().apply {
            if (visionModel.isNotEmpty()) put("model", visionModel)
            put("max_tokens", 1024)
            put("system", system)
            put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", content)))
        }
    }

    /** Tolerant parse: map by `id`, fall back to defaults per band so a
     *  count mismatch degrades instead of failing the whole pass. */
    private fun parseSegments(json: JSONObject): List<Seg>? {
        val content = json.optJSONArray("content") ?: return null
        var text: String? = null
        for (i in 0 until content.length()) {
            val p = content.optJSONObject(i) ?: continue
            if (p.optString("type") == "text") { text = p.optString("text"); break }
        }
        val raw = text?.trim() ?: return null
        val stripped = raw.removePrefix("```json").removePrefix("```").removeSuffix("```").trim()
        val obj = runCatching { JSONObject(stripped) }.getOrNull()
            ?: Regex("""\{[\s\S]*"segments"[\s\S]*\}""").find(stripped)?.value
                ?.let { runCatching { JSONObject(it) }.getOrNull() }
            ?: return null
        val arr = obj.optJSONArray("segments") ?: return null
        if (arr.length() == 0) return null
        val byId = HashMap<Int, Seg>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            byId[o.optInt("id", i)] = Seg(
                o.optString("label", "Region ${i + 1}"),
                o.optString("colour", "#888888"),
            )
        }
        if (byId.isEmpty()) return null
        return (0 until byId.keys.size.coerceAtLeast(arr.length())).map { i ->
            byId[i] ?: Seg("Region ${i + 1}", "#888888")
        }
    }

    private companion object {
        /** High-contrast visualization palette so the model can tell
         *  regions apart in the banded render (not the user's filaments). */
        val BAND_VIS_PALETTE = listOf(
            "#E53935", "#1E88E5", "#43A047", "#FB8C00", "#8E24AA", "#00ACC1",
            "#F4511E", "#6D4C41", "#EC407A", "#FFEB3B", "#FFFFFF", "#37474F",
        )
    }
}
