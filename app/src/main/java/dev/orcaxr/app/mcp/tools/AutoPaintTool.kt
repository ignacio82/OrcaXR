package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AutoPaintEngine
import dev.orcaxr.app.MAX_PAINT_SLOTS
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.TierBCapability
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject

/**
 * Smart Auto-Paint (D20, M1) — `auto_paint`.
 *
 * One call paints the WHOLE model with the active filament palette using
 * a deterministic geometric strategy, committed as a single undo step
 * (one [WorkspaceAction.LoadPaintState]). No image, no LLM/vision API.
 *
 * Strategies (see `docs/proposals/smart-auto-paint.md`):
 *  - `height_bands` — slot ramps with position along `axis` (default
 *    Z = build height: the "rainbow by height" look).
 *  - `components` — each disconnected shell its own slot, biggest first.
 *  - `cavity` — recessed/concave faces get a contrast slot.
 *  - `auto` — picks `height_bands` (the most universally sensible
 *    deterministic default in M1).
 *  - `recipe` — NOT served here: route to `find_similar_recipe` +
 *    `paint_template`, which already fingerprint catalogued shapes.
 *
 * `dry_run=true` returns the per-slot histogram without committing —
 * use it to preview the split before applying. M1 is physical-only; the
 * FullSpectrum gamut option is deferred (proposal §FullSpectrum drop-in
 * seam) and `use_full_spectrum=true` is rejected with a clear message.
 */
internal class AutoPaintTool(
    private val ws: WorkspaceModel,
) : Tool {
    override val name = "auto_paint"
    override val description =
        "Automatically paint the entire model with the active filament palette using a " +
            "deterministic geometric strategy, in one undo step. strategy: 'height_bands' " +
            "(slot ramps along `axis`, default Z/build-height — rainbow-by-height), " +
            "'components' (each disconnected shell its own slot, largest = slot 1), " +
            "'cavity' (recessed/concave faces get a contrast slot), or 'auto' (= " +
            "height_bands). For known/catalogued shapes prefer find_similar_recipe + " +
            "paint_template instead (pass strategy='recipe' to get a pointer). " +
            "max_colors caps how many palette slots are used (default = palette size, " +
            "max $MAX_PAINT_SLOTS). dry_run=true returns the per-slot histogram WITHOUT " +
            "committing — preview the split first. Replaces the model's existing color " +
            "paint (whole-model operation); support/seam/fuzzy-skin paint is preserved. " +
            "model_id is optional when exactly one model is placed."
    override val inputSchema = Schemas.obj(
        properties = mapOf(
            "model_id" to Schemas.string(
                "Model id. Optional — defaults to the only placed model if there's exactly one.",
            ),
            "strategy" to Schemas.string(
                "'height_bands' | 'components' | 'cavity' | 'auto' (default) | 'recipe' (pointer only)",
            ),
            "axis" to Schemas.string(
                "For height_bands: 'x' | 'y' | 'z' (default 'z' = build height)",
            ),
            "max_colors" to Schemas.integer(
                "Cap on palette slots used (1..$MAX_PAINT_SLOTS). Default = active palette size.",
            ),
            "dry_run" to Schemas.bool(
                "If true, compute + return the histogram but do NOT apply (default false)",
            ),
            "use_full_spectrum" to Schemas.bool(
                "Reserved — FullSpectrum gamut is deferred until FS is verified; true is rejected.",
            ),
        ),
    )

    override suspend fun call(args: JSONObject): ToolResult {
        if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")

        if (args.optBoolean("use_full_spectrum", false)) {
            return ToolResult.error(
                "use_full_spectrum is not available yet: the FullSpectrum gamut option is " +
                    "deferred until PeggyPaletteFullSpectrumParityTest is green and FS Local-Z " +
                    "is hardware-verified (see docs/proposals/smart-auto-paint.md). Re-run " +
                    "physical-only (omit use_full_spectrum).",
            )
        }

        // Resolve model: explicit id, else the sole placed model.
        val models = ws.placedModels.value
        val requestedId = args.optString("model_id").trim()
        val model = when {
            requestedId.isNotEmpty() ->
                models.firstOrNull { it.id == requestedId }
                    ?: return ToolResult.error("No model with id '$requestedId'.")
            models.size == 1 -> models[0]
            models.isEmpty() -> return ToolResult.error("No models placed.")
            else -> return ToolResult.error(
                "model_id is required when more than one model is placed " +
                    "(${models.size} present).",
            )
        }

        val strategyKey = args.optString("strategy").trim().ifEmpty { "auto" }
        if (strategyKey == "recipe") {
            return ToolResult.error(
                "strategy='recipe' is served by find_similar_recipe + paint_template " +
                    "(they fingerprint catalogued shapes). Call find_similar_recipe first, " +
                    "then paint_template with the matched recipe. For a quick geometric " +
                    "paint use strategy='height_bands' | 'components' | 'cavity' | 'auto'.",
            )
        }
        val strategy = if (strategyKey == "auto") {
            AutoPaintEngine.Strategy.HeightBands
        } else {
            AutoPaintEngine.Strategy.fromKey(strategyKey)
                ?: return ToolResult.error(
                    "Unknown strategy '$strategyKey'. Use height_bands | components | " +
                        "cavity | auto | recipe.",
                )
        }
        val axis = args.optString("axis").trim().ifEmpty { "z" }.let { a ->
            AutoPaintEngine.Axis.fromKey(a)
                ?: return ToolResult.error("Unknown axis '$a'. Use x | y | z.")
        }

        // Palette size: the active workspace palette, capped by
        // max_colors. Fall back to 4 if the palette isn't published yet
        // (slots still map to whatever filaments the user has).
        val paletteSize = ws.previewPalette.value.count { it.isNotBlank() }
            .let { if (it > 0) it else 4 }
        val maxColors = if (args.has("max_colors")) {
            args.optInt("max_colors", paletteSize).coerceIn(1, MAX_PAINT_SLOTS)
        } else {
            paletteSize
        }
        val effectiveSlots = minOf(paletteSize, maxColors).coerceIn(1, MAX_PAINT_SLOTS)

        val bvh = ws.getBvh(model.id)
            ?: return ToolResult.error("Couldn't build BVH for '${model.id}'.")
        if (bvh.triCount == 0) return ToolResult.error("Model '${model.id}' has no triangles.")

        val result = AutoPaintEngine.run(bvh, strategy, effectiveSlots, axis)
        if (!AutoPaintEngine.isFullCoverage(result.perTriangleSlot)) {
            // Should not happen for M1 strategies; surface rather than
            // silently ship a partially-painted model.
            return ToolResult.error(
                "Internal: strategy '${strategy.key}' left ${
                    result.perTriangleSlot.count { it.toInt() == 0 }
                } of ${bvh.triCount} triangles unpainted.",
            )
        }

        val histArr = JSONArray()
        for (slot in 1..MAX_PAINT_SLOTS) {
            val c = result.perSlotHistogram[slot]
            if (c > 0) histArr.put(JSONObject().apply { put("slot", slot); put("triangles", c) })
        }

        val dryRun = args.optBoolean("dry_run", false)
        val body = JSONObject().apply {
            put("ok", true)
            put("model_id", model.id)
            put("strategy", result.strategy)
            put("axis", if (strategy == AutoPaintEngine.Strategy.HeightBands) axis.key else JSONObject.NULL)
            put("triangles", bvh.triCount)
            put("palette_size", paletteSize)
            put("slots_used", result.slotsUsed)
            put("per_slot_histogram", histArr)
            put("dry_run", dryRun)
            put("applied", false)
        }

        if (dryRun) {
            return ToolResult.ok(
                "auto_paint dry-run: ${result.strategy} → ${result.slotsUsed} slots over " +
                    "${bvh.triCount} triangles (not applied)",
                body,
            )
        }

        if (!ws.isCapabilityWired(TierBCapability.LoadPaintState)) {
            return ToolResult.error(
                "LoadPaintState capability isn't wired in the active OrcaXR shell, so the " +
                    "auto-paint would be silently dropped. Bring the activity into a screen " +
                    "that wires the Tier-B paint callbacks (Slicer / Prepare on XR; " +
                    "MobileShell on phone) and retry, or use dry_run=true to preview.",
            )
        }

        // Whole-model paint → replace the color channel outright; carry
        // support / seam / fuzzy through untouched. One LoadPaintState
        // = one applyPaintMutation = one undo step.
        ws.emit(
            WorkspaceAction.LoadPaintState(
                modelId = model.id,
                paintFilamentIndex = result.perTriangleSlot,
                supportFlags = model.supportFlags,
                seamFlags = model.seamFlags,
                fuzzySkinFlags = model.fuzzySkinFlags,
            ),
        )
        body.put("applied", true)
        return ToolResult.ok(
            "auto_paint: ${result.strategy} painted ${bvh.triCount} triangles across " +
                "${result.slotsUsed} slots (one undo step).",
            body,
        )
    }
}
