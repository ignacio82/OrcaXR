package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiRenderEngine
import dev.orcaxr.app.AutoPaintCascade
import dev.orcaxr.app.AutoPaintEngine
import dev.orcaxr.app.AutoPaintImageEngine
import dev.orcaxr.app.MAX_PAINT_SLOTS
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.TierBCapability
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

/**
 * Smart Auto-Paint (D20) — `auto_paint`.
 *
 * One call paints the WHOLE model in a single undo step (one
 * [WorkspaceAction.LoadPaintState]). Two modes:
 *
 * **Geometric (M1, no image, no API).** strategy ∈ height_bands |
 * components | cavity | auto. Slots map 1:1 to the active palette.
 *
 * **Target image (M2).** Pass `image_base64` or `image_token`. The
 * image is projected onto the model (occlusion-correct TriangleId
 * render), each triangle's mean color is quantized to the
 * perceptually-nearest filament slot (CIEDE2000), and unsampled faces
 * inherit the nearest visible color so the whole model is covered. If
 * no `camera_descriptor` is given, the camera is auto-picked by
 * silhouette-IoU over the named presets (best for a roughly-aligned
 * reference render / mock; a real off-axis photo is the M4 semantic
 * path). Single image → only the camera-facing side carries true color.
 *
 * `dry_run=true` returns the per-slot histogram without committing.
 * Physical-only; `use_full_spectrum=true` is rejected (FS deferred
 * until PeggyPalette is green — proposal §FullSpectrum drop-in seam).
 * For catalogued shapes prefer find_similar_recipe + paint_template
 * (strategy='recipe' returns that pointer).
 */
internal class AutoPaintTool(
    private val ws: WorkspaceModel,
    private val session: AiSessionState,
) : Tool {
    override val name = "auto_paint"
    override val description =
        "Automatically paint the entire model in one undo step. GEOMETRIC/CASCADE mode " +
            "(no image/API). Default strategy 'auto'/'cascade' is metadata-aware: it " +
            "respects the model's existing paint, else segments by shells (small-shell " +
            "merge + palette cap), else geometry — and reports `source` + " +
            "`alternate_source`. Force a strategy with 'height_bands' (ramp along `axis`, " +
            "default Z), 'components' (each shell its own slot), or 'cavity' (contrast in " +
            "recesses). " +
            "TARGET-IMAGE mode (pass image_base64 OR image_token): the image is projected " +
            "onto the model and each face quantized to the perceptually-nearest filament " +
            "(CIEDE2000); unseen faces inherit the nearest color for full coverage. " +
            "camera_descriptor (from render_view) is optional — without it the camera is " +
            "auto-picked by silhouette match over the standard views. max_colors caps " +
            "palette slots (1..$MAX_PAINT_SLOTS). dry_run=true previews the histogram " +
            "without applying. Replaces the model's color paint; support/seam/fuzzy are " +
            "preserved. model_id optional when exactly one model is placed. For " +
            "catalogued shapes prefer find_similar_recipe + paint_template."
    override val inputSchema = Schemas.obj(
        properties = mapOf(
            "model_id" to Schemas.string(
                "Model id. Optional — defaults to the only placed model if there's exactly one.",
            ),
            "strategy" to Schemas.string(
                "'auto'/'cascade' (default — metadata-aware: respects existing paint, " +
                    "else shells, else geometry; reports source + alternate_source), or a " +
                    "forced geometric strategy 'height_bands' | 'components' | 'cavity', or " +
                    "'recipe' (pointer only). Ignored when an image is supplied.",
            ),
            "axis" to Schemas.string("For height_bands: 'x' | 'y' | 'z' (default 'z')"),
            "image_base64" to Schemas.string("Base64 PNG target image (RGBA). Enables image mode."),
            "image_token" to Schemas.string("render_view token to use as the target image instead."),
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
            "background_color" to Schemas.string(
                "'#RRGGBB' background to exclude from the target image (else inferred " +
                    "from corners / alpha).",
            ),
            "max_colors" to Schemas.integer(
                "Cap on palette slots used (1..$MAX_PAINT_SLOTS). Default = active palette size.",
            ),
            "dry_run" to Schemas.bool("Compute + return the histogram but do NOT apply (default false)"),
            "use_full_spectrum" to Schemas.bool(
                "Reserved — FullSpectrum gamut is deferred; true is rejected.",
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
            .let { if (it > 0) it else 4 }
        val maxColors = if (args.has("max_colors")) {
            args.optInt("max_colors", paletteSize).coerceIn(1, MAX_PAINT_SLOTS)
        } else {
            paletteSize
        }
        val dryRun = args.optBoolean("dry_run", false)

        val hasImage = args.has("image_base64") || args.has("image_token")
        val strategyKey = args.optString("strategy").trim()
        val outcome = when {
            hasImage -> runImage(args, bvh, maxColors)
            strategyKey == "" || strategyKey == "auto" || strategyKey == "cascade" ->
                runCascade(args, bvh, model.paintFilamentIndex, minOf(paletteSize, maxColors))
            else -> runGeometric(args, bvh, minOf(paletteSize, maxColors))
        }
        val (perTri, modeBody, summary) = when (outcome) {
            is Run.Err -> return outcome.result
            is Run.Ok -> Triple(outcome.perTriangleSlot, outcome.body, outcome.summary)
        }

        if (!AutoPaintEngine.isFullCoverage(perTri)) {
            return ToolResult.error(
                "Internal: ${summary} left ${perTri.count { it.toInt() == 0 }} of " +
                    "${bvh.triCount} triangles unpainted.",
            )
        }

        val histArr = JSONArray()
        var slotsUsed = 0
        val hist = IntArray(MAX_PAINT_SLOTS + 1)
        for (s in perTri) hist[s.toInt() and 0xff]++
        for (slot in 1..MAX_PAINT_SLOTS) {
            if (hist[slot] > 0) {
                slotsUsed++
                histArr.put(JSONObject().apply { put("slot", slot); put("triangles", hist[slot]) })
            }
        }

        val body = JSONObject().apply {
            put("ok", true)
            put("model_id", model.id)
            put("triangles", bvh.triCount)
            put("palette_size", paletteSize)
            put("slots_used", slotsUsed)
            put("per_slot_histogram", histArr)
            put("dry_run", dryRun)
            put("applied", false)
            for (k in modeBody.keys()) put(k, modeBody.get(k))
        }

        if (dryRun) {
            return ToolResult.ok(
                "auto_paint dry-run: $summary → $slotsUsed slots over ${bvh.triCount} " +
                    "triangles (not applied)",
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

        ws.emit(
            WorkspaceAction.LoadPaintState(
                modelId = model.id,
                paintFilamentIndex = perTri,
                supportFlags = model.supportFlags,
                seamFlags = model.seamFlags,
                fuzzySkinFlags = model.fuzzySkinFlags,
            ),
        )
        body.put("applied", true)
        return ToolResult.ok(
            "auto_paint: $summary painted ${bvh.triCount} triangles across $slotsUsed " +
                "slots (one undo step).",
            body,
        )
    }

    /** Local result of a run* helper — no shared mutable state (the
     *  tool instance is a registered singleton; call() can run
     *  concurrently). */
    private sealed interface Run {
        data class Ok(
            val perTriangleSlot: ByteArray,
            val body: JSONObject,
            val summary: String,
        ) : Run
        data class Err(val result: ToolResult) : Run
    }

    /** Borrowed ideas #1/#4/#5: the metadata-aware prioritized cascade
     *  (paint-state → components → geometric), with the source + the
     *  alternate a follow-up could use surfaced in the result. */
    private fun runCascade(
        args: JSONObject,
        bvh: dev.orcaxr.app.MeshBvh,
        existingPaint: ByteArray?,
        effectiveSlots: Int,
    ): Run {
        val axisKey = args.optString("axis").trim().ifEmpty { "z" }
        val axis = AutoPaintEngine.Axis.fromKey(axisKey)
            ?: return Run.Err(ToolResult.error("Unknown axis '$axisKey'. Use x | y | z."))
        val r = AutoPaintCascade.run(
            bvh, existingPaint, effectiveSlots.coerceIn(1, MAX_PAINT_SLOTS), axis,
        )
        val mb = JSONObject().apply {
            put("mode", "cascade")
            put("strategy", "cascade")
            put("source", r.source.key)
            put("alternate_source", r.alternateSource?.key ?: JSONObject.NULL)
            put("branches_available", org.json.JSONArray(r.branchesAvailable))
            put("axis", if (r.source == AutoPaintCascade.Source.HeightBands) axis.key else JSONObject.NULL)
        }
        return Run.Ok(r.perTriangleSlot, mb, "cascade(${r.source.key})")
    }

    private fun runGeometric(
        args: JSONObject,
        bvh: dev.orcaxr.app.MeshBvh,
        effectiveSlots: Int,
    ): Run {
        val strategyKey = args.optString("strategy").trim().ifEmpty { "auto" }
        if (strategyKey == "recipe") {
            return Run.Err(ToolResult.error(
                "strategy='recipe' is served by find_similar_recipe + paint_template " +
                    "(they fingerprint catalogued shapes). Call find_similar_recipe first, " +
                    "then paint_template. For a quick geometric paint use strategy=" +
                    "'height_bands' | 'components' | 'cavity' | 'auto'.",
            ))
        }
        val strategy = if (strategyKey == "auto") {
            AutoPaintEngine.Strategy.HeightBands
        } else {
            AutoPaintEngine.Strategy.fromKey(strategyKey)
                ?: return Run.Err(ToolResult.error(
                    "Unknown strategy '$strategyKey'. Use height_bands | components | " +
                        "cavity | auto | recipe.",
                ))
        }
        val axisKey = args.optString("axis").trim().ifEmpty { "z" }
        val axis = AutoPaintEngine.Axis.fromKey(axisKey)
            ?: return Run.Err(ToolResult.error("Unknown axis '$axisKey'. Use x | y | z."))
        val r = AutoPaintEngine.run(bvh, strategy, effectiveSlots.coerceIn(1, MAX_PAINT_SLOTS), axis)
        val mb = JSONObject().apply {
            put("mode", "geometric")
            put("strategy", r.strategy)
            put("axis", if (strategy == AutoPaintEngine.Strategy.HeightBands) axis.key else JSONObject.NULL)
        }
        return Run.Ok(r.perTriangleSlot, mb, r.strategy)
    }

    private fun runImage(
        args: JSONObject,
        bvh: dev.orcaxr.app.MeshBvh,
        maxColors: Int,
    ): Run {
        val pngBytes: ByteArray = when {
            args.has("image_base64") -> {
                val b64 = args.optString("image_base64").trim()
                if (b64.isEmpty()) return Run.Err(ToolResult.error("image_base64 is empty."))
                runCatching { Base64.getDecoder().decode(b64) }.getOrNull()
                    ?: return Run.Err(ToolResult.error("image_base64 is not valid base64."))
            }
            else -> {
                val tok = args.optString("image_token").trim()
                if (tok.isEmpty()) return Run.Err(ToolResult.error("image_token is empty."))
                session.getArtifact(tok)?.pngBytes
                    ?: return Run.Err(ToolResult.error("image_token '$tok' not found in session cache."))
            }
        }
        val decoded = AiRenderEngine.decodePng(pngBytes)
            ?: return Run.Err(ToolResult.error("Couldn't decode PNG bytes."))

        val paletteHex = ws.previewPalette.value.filter { it.isNotBlank() }.take(maxColors)
        val palette = AutoPaintImageEngine.paletteFromHex(paletteHex)
        if (palette.isEmpty()) {
            return Run.Err(ToolResult.error(
                "No usable palette — set the workspace filament colors before image auto-paint.",
            ))
        }

        val bgArg = args.optString("background_color").takeIf { it.isNotBlank() }
        val bg: IntArray? = if (bgArg != null) {
            val lab = bgArg.trim().trimStart('#')
            val r = if (lab.length >= 6) lab.substring(0, 2).toIntOrNull(16) else null
            val g = if (lab.length >= 6) lab.substring(2, 4).toIntOrNull(16) else null
            val b = if (lab.length >= 6) lab.substring(4, 6).toIntOrNull(16) else null
            if (r == null || g == null || b == null) {
                return Run.Err(ToolResult.error("background_color '$bgArg' is not a valid #RRGGBB."))
            }
            intArrayOf(r, g, b)
        } else {
            null
        }

        // Camera: explicit descriptor, else silhouette-IoU auto-pick.
        var pickedPreset: String? = null
        var iou = -1.0
        val camera: AiRenderEngine.CameraSpec
        val descriptor = args.optJSONObject("camera_descriptor")
        if (descriptor != null) {
            val view = descriptor.optJSONArray("view_matrix_4x4")
            val proj = descriptor.optJSONArray("projection_matrix_4x4")
            if (view == null || proj == null || view.length() != 16 || proj.length() != 16) {
                return Run.Err(ToolResult.error(
                    "camera_descriptor needs view_matrix_4x4 + projection_matrix_4x4 (16 floats each).",
                ))
            }
            val w = descriptor.optInt("width_px", 0)
            val h = descriptor.optInt("height_px", 0)
            if (w <= 0 || h <= 0 || w > 1024 || h > 1024) {
                return Run.Err(ToolResult.error("camera_descriptor.{width,height}_px must be 1..1024."))
            }
            camera = AiRenderEngine.CameraSpec(
                FloatArray(16) { view.optDouble(it, 0.0).toFloat() },
                FloatArray(16) { proj.optDouble(it, 0.0).toFloat() },
                w, h,
            )
        } else {
            val best = AutoPaintImageEngine.bestPresetBySilhouette(
                bvh, decoded.rgba, decoded.widthPx, decoded.heightPx,
                widthPx = 256, heightPx = 256, backgroundRgb = bg,
            )
            pickedPreset = best.first
            iou = best.third
            camera = best.second
        }

        val proj = AutoPaintImageEngine.project(
            bvh, camera, decoded.rgba, decoded.widthPx, decoded.heightPx, palette, backgroundRgb = bg,
        )
        if (proj.coveredTriangles == 0) {
            return Run.Err(ToolResult.error(
                "The target image didn't cover any model triangle (camera/silhouette " +
                    "mismatch or fully-background image). Try supplying a camera_descriptor " +
                    "from render_view, or check background_color.",
            ))
        }
        val out = proj.perTriangleSlot
        if (!AutoPaintImageEngine.finalizeCoverage(bvh, out)) {
            return Run.Err(ToolResult.error("Projection produced no paint."))
        }
        val mb = JSONObject().apply {
            put("mode", "image")
            put("camera", if (pickedPreset != null) "auto:$pickedPreset" else "descriptor")
            if (pickedPreset != null) put("silhouette_iou", String.format("%.3f", iou).toDouble())
            put("covered_triangles", proj.coveredTriangles)
            put("sampled_pixels", proj.sampledPixels)
            put("decal_width", decoded.widthPx)
            put("decal_height", decoded.heightPx)
        }
        val label = "image" + (pickedPreset?.let { " (auto cam: $it)" } ?: " (camera)")
        return Run.Ok(out, mb, label)
    }
}
