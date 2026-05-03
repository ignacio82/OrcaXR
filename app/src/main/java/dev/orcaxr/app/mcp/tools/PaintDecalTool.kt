package dev.orcaxr.app.mcp.tools

import dev.orcaxr.app.AiDecalEngine
import dev.orcaxr.app.AiRenderEngine
import dev.orcaxr.app.MAX_PAINT_SLOTS
import dev.orcaxr.app.PlacedModel
import dev.orcaxr.app.mcp.AiSessionState
import dev.orcaxr.app.mcp.Schemas
import dev.orcaxr.app.mcp.Tool
import dev.orcaxr.app.mcp.ToolResult
import dev.orcaxr.app.mcp.WorkspaceAction
import dev.orcaxr.app.mcp.WorkspaceModel
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

/**
 * D19c — paint_decal. Reverse-projects an RGBA image through a camera
 * onto the model and quantizes per-pixel color to the closest filament
 * slot, assigning the winning slot to each touched triangle. One call
 * paints an entire multi-color decal (eyes + pupils + mouth + ...) in
 * a single undo step via WorkspaceAction.LoadPaintState.
 *
 * The image source is one of:
 *  - `image_base64`: a base64-encoded PNG (the LLM authors a small
 *    decal — face texture, logo, sticker — and feeds it directly).
 *  - `image_token`: a token returned by a previous `render_view` /
 *    cached AiSessionState entry. Useful when the decal IS another
 *    rendered view of a model (e.g. the LLM stamps Pikachu's face
 *    from one view onto a re-orientation).
 *
 * Color → slot assignment:
 *  - If `palette` is provided, each entry maps a `#RRGGBB` to a
 *    1-based slot id. Pixels are quantized to the closest entry.
 *  - Otherwise the active workspace palette is used (each slot's hex
 *    color comes from `WorkspaceModel.previewPalette`).
 *
 * Coordinate frame: same as paint_projected_mask — camera lives in
 * centered_preview_mm. The LLM gets a camera_descriptor from
 * `render_view` and feeds it back in.
 */
internal class PaintDecalTool(
    private val ws: WorkspaceModel,
    private val session: AiSessionState,
) : Tool {
    override val name = "paint_decal"
    override val description =
        "Project a 2D RGBA decal image onto the model from a camera direction; per-pixel " +
            "color is quantized to the closest filament-slot color from `palette` (or the " +
            "active workspace palette) and the matching slot tag is applied to each touched " +
            "triangle. Single undo step (one LoadPaintState action). Use this for face " +
            "textures, logos, multi-color stickers, eye + pupil composites — anything the " +
            "LLM authors as a small RGBA image instead of as N separate paint primitives. " +
            "Image is supplied as a base64 PNG (image_base64) OR as a render_view token " +
            "(image_token). Optional target_rect places the decal inside a sub-rectangle " +
            "of the camera frame; default fills the whole frame. alpha_threshold (default 16) " +
            "skips transparent pixels; ignore_color (default null) skips pixels matching the " +
            "given background hex. Decal merges with the current paint state (transparent " +
            "pixels preserve existing paint) — pass `replace_existing=true` to wipe first."
    override val inputSchema = Schemas.obj(
        required = listOf("model_id", "camera_descriptor"),
        properties = mapOf(
            "model_id" to Schemas.string("Model id"),
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
            "image_base64" to Schemas.string("Base64-encoded PNG of the decal image (RGBA)"),
            "image_token" to Schemas.string("Token from a prior render_view (use instead of image_base64)"),
            "target_rect" to Schemas.obj(
                properties = mapOf(
                    "x0" to Schemas.integer("Left edge (inclusive)"),
                    "y0" to Schemas.integer("Top edge (inclusive)"),
                    "x1" to Schemas.integer("Right edge (exclusive)"),
                    "y1" to Schemas.integer("Bottom edge (exclusive)"),
                ),
            ),
            "palette" to JSONObject().apply {
                put("type", "array")
                put("description", "List of {hex, slot} entries — overrides the workspace palette")
                put("items", Schemas.obj(
                    required = listOf("hex", "slot"),
                    properties = mapOf(
                        "hex" to Schemas.string("'#RRGGBB' filament color"),
                        "slot" to Schemas.integer("1-based filament slot"),
                    ),
                ))
            },
            "alpha_threshold" to Schemas.integer("Pixels with alpha < this are skipped (0..255, default 16)"),
            "ignore_color" to Schemas.string("'#RRGGBB' background color to treat as transparent"),
            "back_face_filter" to Schemas.bool("Reject hits whose normal faces away from the camera (default true)"),
            "replace_existing" to Schemas.bool("If true, wipe the model's color paint before applying the decal (default false — overlay)"),
        ),
    )

    override suspend fun call(args: JSONObject): ToolResult {
        if (!ws.attached.value) return ToolResult.error("OrcaXR not attached.")
        val modelId = args.optString("model_id").trim()
        if (modelId.isEmpty()) return ToolResult.error("'model_id' is required.")
        val model = ws.placedModels.value.firstOrNull { it.id == modelId }
            ?: return ToolResult.error("No model with id '$modelId'.")
        val bvh = ws.getBvh(modelId)
            ?: return ToolResult.error("Couldn't build BVH for '$modelId'.")

        val descriptor = args.optJSONObject("camera_descriptor")
            ?: return ToolResult.error("'camera_descriptor' is required (from render_view).")
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
        val viewArr = FloatArray(16) { view.optDouble(it, 0.0).toFloat() }
        val projArr = FloatArray(16) { proj.optDouble(it, 0.0).toFloat() }
        val camera = AiRenderEngine.CameraSpec(viewArr, projArr, w, h)

        // Resolve image source.
        val pngBytes: ByteArray = when {
            args.has("image_base64") -> {
                val b64 = args.optString("image_base64").trim()
                if (b64.isEmpty()) return ToolResult.error("image_base64 is empty.")
                runCatching { Base64.getDecoder().decode(b64) }.getOrNull()
                    ?: return ToolResult.error("image_base64 is not valid base64.")
            }
            args.has("image_token") -> {
                val tok = args.optString("image_token").trim()
                if (tok.isEmpty()) return ToolResult.error("image_token is empty.")
                session.getArtifact(tok)?.pngBytes
                    ?: return ToolResult.error("image_token '$tok' not found in session cache.")
            }
            else -> return ToolResult.error("provide image_base64 OR image_token.")
        }
        val decoded = AiRenderEngine.decodePng(pngBytes)
            ?: return ToolResult.error("Couldn't decode PNG bytes.")

        // Target rect.
        val target = args.optJSONObject("target_rect")?.let { rect ->
            val x0 = rect.optInt("x0", 0)
            val y0 = rect.optInt("y0", 0)
            val x1 = rect.optInt("x1", w)
            val y1 = rect.optInt("y1", h)
            if (x0 < 0 || y0 < 0 || x1 > w || y1 > h || x1 <= x0 || y1 <= y0) {
                return ToolResult.error(
                    "target_rect ($x0,$y0)-($x1,$y1) outside camera frame ${w}x${h} or empty.",
                )
            }
            AiDecalEngine.TargetRect(x0, y0, x1, y1)
        }

        // Palette resolution.
        val palette = resolvePalette(args)
            ?: return ToolResult.error(
                "No palette available — pass `palette` arg or set the workspace's previewPalette.",
            )

        val alphaThreshold = args.optInt("alpha_threshold", 16).coerceIn(0, 255)
        val ignoreRgb: IntArray? = args.optString("ignore_color").takeIf { it.isNotBlank() }?.let {
            AiDecalEngine.parseHexColor(it)
                ?: return ToolResult.error("ignore_color '$it' is not a valid #RRGGBB hex.")
        }
        val backFace = args.optBoolean("back_face_filter", true)
        val replaceExisting = args.optBoolean("replace_existing", false)

        val result = AiDecalEngine.project(
            bvh = bvh,
            camera = camera,
            decalRgba = decoded.rgba,
            decalWidth = decoded.widthPx,
            decalHeight = decoded.heightPx,
            target = target,
            palette = palette,
            alphaThreshold = alphaThreshold,
            ignoreRgb = ignoreRgb,
            backFaceFilter = backFace,
        )
        if (result.activeSourcePixels == 0) {
            return ToolResult.error(
                "Decal had no active pixels (every sampled pixel was below alpha_threshold or " +
                    "matched ignore_color). Check alpha_threshold (current=$alphaThreshold) and " +
                    "ignore_color args.",
            )
        }

        // Compose the final color array: existing paint (or zeros if
        // replace_existing) underlaid with the decal's per-triangle
        // slot. Non-zero decal slots win.
        val baseColor = if (replaceExisting) null else model.paintFilamentIndex
        val finalColor = AiDecalEngine.overlay(baseColor, result.perTriangleSlot)

        // One LoadPaintState replays as one undo step. We only mutate
        // the color channel; carry support / seam / fuzzy through.
        ws.emit(WorkspaceAction.LoadPaintState(
            modelId = modelId,
            paintFilamentIndex = finalColor,
            supportFlags = model.supportFlags,
            seamFlags = model.seamFlags,
            fuzzySkinFlags = model.fuzzySkinFlags,
        ))

        // Build response.
        val histArr = JSONArray()
        for (slot in 1..MAX_PAINT_SLOTS) {
            val n = result.perSlotHistogram.getOrElse(slot) { 0 }
            if (n > 0) histArr.put(JSONObject().apply {
                put("slot", slot); put("triangles", n)
            })
        }
        val totalPainted = result.perSlotHistogram.drop(1).sum()
        val body = JSONObject().apply {
            put("ok", true)
            put("model_id", modelId)
            put("active_source_pixels", result.activeSourcePixels)
            put("triangles_touched", result.triangleHitCount)
            put("triangles_painted", totalPainted)
            put("per_slot_histogram", histArr)
            put("palette_size", palette.size)
            put("decal_width", decoded.widthPx)
            put("decal_height", decoded.heightPx)
            put("target_rect", JSONObject().apply {
                val r = target ?: AiDecalEngine.TargetRect(0, 0, w, h)
                put("x0", r.x0); put("y0", r.y0); put("x1", r.x1); put("y1", r.y1)
            })
            put("replace_existing", replaceExisting)
            put("back_face_filter", backFace)
        }
        val text = "paint_decal: ${result.activeSourcePixels} px → $totalPainted triangles, " +
            "${histArr.length()} slots used (${if (replaceExisting) "replace" else "overlay"})"
        return ToolResult.ok(text, body)
    }

    /** Returns null when neither the args nor the workspace can supply
     *  a palette. Otherwise returns the palette in 1-based-slot order
     *  (slot 1 first). Empty hex entries in the workspace palette are
     *  skipped — those are filament rows the user hasn't filled in. */
    private fun resolvePalette(args: JSONObject): List<AiDecalEngine.PaletteSlot>? {
        val explicit = args.optJSONArray("palette")
        if (explicit != null && explicit.length() > 0) {
            val out = ArrayList<AiDecalEngine.PaletteSlot>(explicit.length())
            for (i in 0 until explicit.length()) {
                val entry = explicit.optJSONObject(i) ?: continue
                val hex = entry.optString("hex").trim()
                val slot = entry.optInt("slot", -1)
                if (slot < 1 || slot > MAX_PAINT_SLOTS) continue
                val rgb = AiDecalEngine.parseHexColor(hex) ?: continue
                out.add(AiDecalEngine.PaletteSlot(slot, rgb[0], rgb[1], rgb[2]))
            }
            if (out.isEmpty()) return null
            return out
        }
        val ws = ws.previewPalette.value
        if (ws.isEmpty()) return null
        val out = ArrayList<AiDecalEngine.PaletteSlot>(ws.size)
        for ((i, hex) in ws.withIndex()) {
            val rgb = AiDecalEngine.parseHexColor(hex) ?: continue
            out.add(AiDecalEngine.PaletteSlot(i + 1, rgb[0], rgb[1], rgb[2]))
        }
        if (out.isEmpty()) return null
        return out
    }
}
